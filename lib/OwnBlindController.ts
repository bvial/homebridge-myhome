import type { Logging } from 'homebridge';
import { performance } from 'node:perf_hooks';
import { OwnClient, PKT } from './OwnNet';
import { BlindPositionEstimator, type BlindDirection, type BlindTiming } from './BlindPositionEstimator';
import { errorMessage } from './utils';
import { OwnProtcol } from './OwnProtcol';

export type PositionConfidence = 'unknown' | 'estimated' | 'calibrated' | 'measured';
export type BlindPhase = 'idle' | 'starting' | 'moving' | 'stopping' | 'reversing' | 'calibrating' | 'fault';
export interface BlindConfig {
    id: number;
    name?: string;
    time?: number;
    timeUp?: number;
    timeDown?: number;
    timeSlat?: number;
    slatPercent?: number;
    calibrateOnStart?: boolean;
    calibration?: 'always' | 'whenUnknown' | 'manual';
    calibrationSwitch?: boolean;
    postStopGraceMs?: number;
    where?: string;
}
export interface BlindCache {
    position: number;
    confidence: PositionConfidence;
    updatedAt: number;
    wasMoving: boolean;
}
export interface BlindState {
    position: number;
    targetPosition: number;
    moving: BlindDirection;
    online: boolean;
    positionConfidence: PositionConfidence;
    blindPhase: BlindPhase;
    calibrating: boolean;
}
export class BlindError extends Error {
    constructor(readonly code: 'offline' | 'busy' | 'cancelled' | 'timeout' | 'communication' | 'invalid', message: string) {
        super(message);
    }
}
interface Operation {
    id: number;
    target: number;
    calibration: boolean;
    reference: boolean;
    jog: boolean;
    acknowledged?: boolean;
    reached?: boolean;
    deadline?: number;
    resolve(): void;
    reject(error: Error): void;
}
interface Transmission {
    direction: BlindDirection;
    sentAt?: number;
    sequence: number;
    manualRevision: number;
    echoed: boolean;
    completed: boolean;
    expires: number;
    promise: Promise<void>;
}

/** One motor state machine for both adapters. No HAP services or characteristics. */
export class OwnBlindController {
    private readonly estimator: BlindPositionEstimator;
    private readonly key: string;
    private readonly policy: NonNullable<BlindConfig['calibration']>;
    private readonly graceMs: number;
    private readonly now: () => number;
    private readonly wallNow: () => number;
    private online = false;
    private disposed = false;
    private initialized = false;
    private confidence: PositionConfidence;
    private uncertainMotion = false;
    private phase: BlindPhase = 'idle';
    private target: number;
    private generation = 0;
    private busRevision = 0;
    private sentSequence = 0;
    private manualRevision = 0;
    private operation?: Operation;
    private transmissions: Transmission[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private manualDeadline?: number;
    private graceUntil = 0;
    private lastDirection: BlindDirection = 'stopped';
    private lastBucket = -1;
    private queryPending = false;
    readonly where: string;
    private actuatorDisabled = false;
    private reportedPosition?: number | null;

    constructor(
        private readonly client: OwnClient,
        private readonly log: Logging,
        readonly config: BlindConfig,
        context: Record<string, unknown>,
        private readonly changed: (state: BlindState, persist?: 'now' | 'later') => void,
        clock: { now?: () => number; wallNow?: () => number } = {},
    ) {
        this.now = clock.now ?? (() => performance.now());
        this.wallNow = clock.wallNow ?? (() => Date.now());
        if (!Number.isInteger(config.id) || config.id <= 0) throw new Error('Blind id must be a positive integer');
        this.where = config.where ?? String(config.id);
        if (!OwnProtcol.isWhere(this.where)) throw new Error('Blind where must be an OpenWebNet address');
        const positive = (value: unknown, name: string): number => {
            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 3600) {
                throw new Error(`Blind ${config.id}: ${name} must be a positive number of seconds (maximum 3600)`);
            }
            return value;
        };
        const timing: BlindTiming = {
            timeUp: positive(config.timeUp ?? config.time, 'timeUp or time'),
            timeDown: positive(config.timeDown ?? config.time, 'timeDown or time'),
            timeSlat: config.timeSlat ?? 0,
            slatPercent: config.slatPercent ?? 0,
        };
        if (!Number.isFinite(timing.timeSlat) || timing.timeSlat < 0 || timing.timeSlat > 3600
            || !Number.isFinite(timing.slatPercent) || timing.slatPercent < 0 || timing.slatPercent >= 100
            || (timing.timeSlat > 0) !== (timing.slatPercent > 0)) {
            throw new Error(`Blind ${config.id}: timeSlat and slatPercent must both be zero or both positive; slatPercent must be below 100`);
        }
        this.policy = config.calibration ?? (config.calibrateOnStart === false ? 'manual' : 'always');
        if (!['always', 'whenUnknown', 'manual'].includes(this.policy)) throw new Error('Invalid blind calibration policy');
        this.graceMs = config.postStopGraceMs ?? 150;
        if (!Number.isFinite(this.graceMs) || this.graceMs < 0 || this.graceMs > 1000) throw new Error('postStopGraceMs must be in 0..1000');
        const cache = context.blindState as Partial<BlindCache> | undefined;
        const valid = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 100;
        const position = valid(cache?.position) ? cache.position : valid(context.blindPosition) ? context.blindPosition : 0;
        this.confidence = valid(cache?.position) && ['unknown', 'estimated', 'calibrated', 'measured'].includes(cache?.confidence ?? '')
            ? cache.confidence! : valid(context.blindPosition) ? 'estimated' : 'unknown';
        if (cache?.wasMoving || (typeof cache?.updatedAt === 'number' && this.wallNow() - cache.updatedAt > 86_400_000)) this.confidence = 'unknown';
        this.estimator = new BlindPositionEstimator(timing, position);
        this.target = position;
        this.key = `2:${config.id}`;
    }

    snapshot(): BlindState {
        return {
            position: this.estimator.position(this.now()), targetPosition: this.target,
            moving: this.estimator.direction, online: this.online && !this.disposed,
            positionConfidence: this.confidence, blindPhase: this.phase,
            calibrating: !!this.operation?.calibration,
        };
    }

    serialize(): BlindCache {
        return { position: this.estimator.position(this.now()), confidence: this.confidence,
            updatedAt: this.wallNow(), wasMoving: this.estimator.direction !== 'stopped' || this.uncertainMotion };
    }

    private notify(persist?: 'now' | 'later'): void {
        if (this.disposed) return;
        const state = this.snapshot();
        const bucket = Math.floor(state.position / 10);
        if (bucket !== this.lastBucket) { this.lastBucket = bucket; persist ??= 'later'; }
        this.changed(state, persist);
    }

    setOnline(online: boolean): void {
        if (this.disposed || this.online === online) return;
        this.online = online;
        if (!online) {
            const needsStop = this.estimator.direction !== 'stopped' || this.transmissions.some(t => !t.completed);
            this.uncertainMotion = needsStop;
            this.confidence = 'unknown';
            this.busRevision++;
            this.manualRevision++;
            this.cancel(new BlindError('offline', 'Gateway disconnected'));
            this.estimator.stop(this.now());
            this.phase = 'fault';
            // A monitor failure can leave the command channel usable. Keep one
            // best-effort STOP, never replay an old movement on reconnect.
            if (needsStop) void this.send('stopped', this.generation).catch(err => this.log.warn('[%s] Disconnect STOP failed: %s', this.config.id, errorMessage(err)));
        }
        this.notify('now');
    }

    updateStatus(): void {
        if (!this.online || this.disposed) return;
        if (!this.initialized) {
            this.initialized = true;
            if (this.policy === 'always' || (this.policy === 'whenUnknown' && this.confidence === 'unknown')) {
                void this.calibrate().catch(err => this.log.warn('[%s] Calibration failed: %s', this.config.id, errorMessage(err)));
                return;
            }
        }
        if (this.operation || this.queryPending || this.transmissions.some(t => !t.completed)) return;
        const revision = this.busRevision;
        const generation = this.generation;
        this.queryPending = true;
        const queued = this.client.sendCommand({
            command: `*#2*${this.where}##`, serialKey: `${this.key}:status`, priority: 'background',
            expiresAt: Date.now() + 5000,
            shouldSend: () => !this.disposed && this.online && !this.operation && generation === this.generation,
            packet: packet => {
                if (revision === this.busRevision && generation === this.generation && !this.operation) this.onData(packet, 'status');
            },
            done: () => { this.queryPending = false; },
        });
        if (!queued) this.queryPending = false;
    }

    moveTo(target: number): Promise<void> {
        this.log.info('[%s] Blind target requested: %s%% (position=%s%%, confidence=%s, phase=%s)',
            this.config.id, target, Math.round(this.estimator.position(this.now())), this.confidence, this.phase);
        if (!Number.isFinite(target) || target < 0 || target > 100) return Promise.reject(new BlindError('invalid', 'Position must be in 0..100'));
        if (this.reportedPosition === null && target !== 0 && target !== 100) {
            return Promise.reject(new BlindError('invalid', 'Actuator reports unknown position (255): fully open or close the blind before choosing a partial position'));
        }
        if (this.confidence !== 'unknown' && Math.abs(target - this.estimator.position(this.now())) < 0.01
            && (this.estimator.direction !== 'stopped' || this.transmissions.some(t => !t.completed))) return this.stop();
        return this.begin(target, false);
    }

    calibrate(): Promise<void> { return this.begin(0, true); }
    identify(): Promise<void> { return this.begin(100, false, true); }

    private begin(target: number, calibration: boolean, jog = false): Promise<void> {
        if (!this.online || this.disposed) return Promise.reject(new BlindError('offline', 'Gateway is offline'));
        if (this.actuatorDisabled) return Promise.reject(new BlindError('invalid', 'The actuator reports a disabled state (WHO 2 shutterInfo 12/13)'));
        this.cancel(new BlindError('cancelled', 'Replaced by a newer blind command'));
        if (calibration) this.confidence = 'unknown';
        this.target = target;
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const result = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
        const op: Operation = { id: this.generation, target, calibration,
            // Legacy timed actuators remain controllable from their last estimate
            // even after cache expiry, reconnect or an interrupted calibration.
            // Only an endpoint request may run a complete reference course.
            reference: !jog && (calibration || (this.confidence === 'unknown' && (target === 0 || target === 100))), jog, resolve, reject };
        this.operation = op;
        this.phase = calibration ? 'calibrating' : 'starting';
        this.notify();
        void this.drive(op).catch(err => this.fail(op, err));
        return result;
    }

    private async drive(op: Operation): Promise<void> {
        const position = this.estimator.position(this.now());
        let direction: Exclude<BlindDirection, 'stopped'> = op.target > position || op.target === 100 ? 'opening' : 'closing';
        const pending = this.transmissions.filter(t => !t.completed).slice(-1)[0];
        if (!op.reference && !op.jog && Math.abs(op.target - position) < 0.01 && !pending && this.estimator.direction === 'stopped') {
            this.operation = undefined; this.phase = 'idle'; op.resolve(); this.notify('now'); return;
        }
        if (pending || this.estimator.direction !== 'stopped') {
            if (!op.reference && !op.jog && pending?.direction === direction) {
                try { await pending.promise; } catch { /* The current intent can retry after a cancelled handshake. */ }
            } else if (op.reference || op.jog || pending || this.estimator.direction !== direction) {
                this.phase = 'reversing';
                await this.send('stopped', op.id);
            }
        }
        if (this.operation !== op || !this.online) return;
        // The first ACK may have been delayed while the motor passed the new target.
        if (!op.reference && !op.jog) {
            const current = this.estimator.position(this.now());
            if (Math.abs(op.target - current) < 0.01) {
                await this.finish(op);
                op.resolve();
                return;
            }
            direction = op.target > current ? 'opening' : 'closing';
            if (this.estimator.direction !== 'stopped' && this.estimator.direction !== direction) {
                this.phase = 'reversing';
                await this.send('stopped', op.id);
                if (this.operation !== op) return;
                direction = op.target > this.estimator.position(this.now()) ? 'opening' : 'closing';
            }
        }
        if (this.estimator.direction !== direction || op.reference || op.jog) {
            await this.send(direction, op.id, startedAt => {
                if (op.reference) op.deadline = startedAt + this.estimator.fullTravel(direction) + 1000;
                else if (op.jog) op.deadline = startedAt + 1000;
            });
        }
        if (this.operation !== op) return;
        op.acknowledged = true;
        if (op.reached && this.estimator.direction === 'stopped') {
            this.operation = undefined;
            this.phase = 'idle';
            this.target = this.estimator.position(this.now());
            op.resolve();
            this.notify('now');
            this.schedule();
            return;
        }
        this.phase = op.calibration ? 'calibrating' : 'moving';
        op.resolve(); // Acknowledgement, not a claim that the target was reached.
        this.notify('now');
        this.schedule();
    }

    async stop(): Promise<void> {
        if (this.disposed || !this.online) throw new BlindError('offline', 'Gateway is offline');
        this.cancel(new BlindError('cancelled', 'Blind stopped'));
        const id = this.generation;
        this.target = this.estimator.position(this.now());
        this.phase = 'stopping';
        this.notify();
        this.schedule();
        try {
            await this.send('stopped', id);
            if (id === this.generation && this.estimator.direction === 'stopped') {
                this.phase = 'idle'; this.target = this.estimator.position(this.now()); this.notify('now');
            }
        } catch (err) {
            if (id === this.generation) this.markFault();
            throw err;
        }
    }

    private cancel(error: Error): void {
        this.generation++;
        this.operation?.reject(error);
        this.operation = undefined;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.client.cancelQueued(this.key);
        this.client.cancelQueued(`${this.key}:status`);
    }

    private send(direction: BlindDirection, generation: number, started?: (at: number) => void): Promise<void> {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
        const transmission: Transmission = { direction, sequence: 0, manualRevision: this.manualRevision, echoed: false,
            completed: false, expires: Infinity, promise };
        this.transmissions = this.transmissions.filter(t => t.expires >= this.now());
        this.transmissions.push(transmission);
        const queuedAt = this.now();
        const code = direction === 'opening' ? 1 : direction === 'closing' ? 2 : 0;
        const queued = this.client.sendCommand({
            command: `*2*${code}*${this.where}##`, serialKey: this.key,
            priority: direction === 'stopped' ? 'stop' : undefined,
            expiresAt: direction === 'stopped' ? undefined : Date.now() + 5000,
            shouldSend: () => !this.disposed && generation === this.generation && (this.online || direction === 'stopped'),
            started: () => {
                transmission.sentAt = this.now();
                transmission.sequence = ++this.sentSequence;
                transmission.manualRevision = this.manualRevision;
                if (direction !== 'stopped') this.uncertainMotion = true;
                this.notify('now');
                started?.(transmission.sentAt);
            },
            done: (packet, _index, failure) => {
                transmission.completed = true;
                transmission.expires = this.now() + 1000;
                if (packet !== PKT.ACK) {
                    transmission.echoed = true;
                    reject(new BlindError(failure === 'cancelled' ? 'cancelled' : failure === 'timeout' || failure === 'expired' ? 'timeout' : 'communication',
                        `Blind command ${code} failed: ${failure ?? 'gateway rejection or disconnection'}`));
                    return;
                }
                if (!this.disposed && transmission.manualRevision === this.manualRevision && !transmission.echoed) {
                    this.observe(direction, transmission.sentAt ?? this.now());
                }
                this.log.debug('[%s] Blind command %s: queue=%dms, ACK=%dms', this.config.id, code,
                    (transmission.sentAt ?? queuedAt) - queuedAt, this.now() - (transmission.sentAt ?? queuedAt));
                resolve();
            },
        });
        if (!queued) {
            transmission.completed = true; transmission.expires = this.now();
            reject(new BlindError('busy', 'Blind command queue is full'));
        }
        return promise;
    }

    onData(packet: string, source: 'monitor' | 'status' = 'monitor'): void {
        if (this.disposed || !this.online) return;
        const report = OwnProtcol.decodeBlindReport(packet);
        if (!report || report.where !== this.where) return;
        const direction = report.direction;
        const actuatorFault = report.disabled || report.rejected;
        const now = this.now();
        this.transmissions = this.transmissions.filter(t => t.expires >= now);
        const echo = source === 'monitor' ? this.transmissions.find(t => t.sentAt !== undefined && !t.echoed && t.direction === direction) : undefined;
        if (!echo && source === 'monitor' && direction !== 'stopped' && direction === this.lastDirection && now < this.graceUntil) {
            this.graceUntil = 0;
            return;
        }
        if (echo) {
            echo.echoed = true;
            // Command and monitor sockets can deliver events in different orders.
            // An old echo must not undo a later transmission or a wall action,
            // nor invalidate the ACK fallback of the current command.
            if (echo.sequence < this.sentSequence || echo.manualRevision !== this.manualRevision) return;
        } else if (report.position === undefined || direction === 'stopped'
            || direction !== this.estimator.direction || actuatorFault) {
            this.manualRevision++;
        }
        this.busRevision++;
        if (report.position !== undefined) {
            this.reportedPosition = report.position;
            // A refusal describes one command. Only the explicit disabled states
            // may prevent subsequent user requests from reaching the gateway.
            this.actuatorDisabled = !!report.disabled;
        }
        const op = this.operation;
        const measuredTarget = typeof report.position === 'number' && op && report.position === op.target;
        const fullRun = report.position === undefined && this.reportedPosition === undefined && op?.reference && op.acknowledged && op.deadline !== undefined
            && now >= op.deadline - 1000 && this.estimator.direction !== 'stopped';
        if (direction === 'stopped' && op && !actuatorFault && (measuredTarget || fullRun)) {
            // WHO 2 §3.0.1 sends STOP at the natural end-stop. The one-second
            // safety margin must not turn a completed full run into a failed calibration.
            this.estimator.reference(op.target, now);
            this.confidence = measuredTarget ? 'measured' : 'calibrated';
            if (op.acknowledged) {
                this.operation = undefined;
                op.resolve();
            } else {
                op.reached = true;
            }
            this.observe('stopped', now);
            return;
        }
        if (source === 'monitor' && !echo && !actuatorFault && (this.operation || this.transmissions.some(t => !t.completed))
            && (direction === 'stopped' || direction !== this.estimator.direction)) {
            if (this.operation?.calibration) this.confidence = 'unknown';
            this.cancel(new BlindError('cancelled', 'Wall control overrides the automatic movement'));
            this.phase = 'idle';
        }
        if (!echo && direction === 'stopped' && this.estimator.direction !== 'stopped') this.graceUntil = now + this.graceMs;
        else this.graceUntil = 0;
        if (report.position !== undefined) {
            if (report.position === null) this.confidence = 'unknown';
            else {
                this.estimator.reference(report.position, now);
                this.confidence = direction === 'stopped' ? 'measured' : 'estimated';
            }
        }
        this.observe(direction, now);
        if (this.actuatorDisabled || report.rejected) {
            this.log.warn('[%s] Blind actuator %s: %s', this.config.id,
                this.actuatorDisabled ? 'disabled' : 'did not execute the command', packet);
            this.cancel(new BlindError('communication', 'Actuator command rejected or disabled'));
            this.markFault();
        }
    }

    private observe(direction: BlindDirection, at: number): void {
        if (direction === 'stopped') {
            this.estimator.stop(at);
            this.uncertainMotion = false;
            this.manualDeadline = undefined;
            if (!this.operation) { this.target = this.estimator.position(at); this.phase = this.online ? 'idle' : 'fault'; }
        } else {
            if (this.estimator.direction !== direction) {
                this.estimator.start(direction, at);
                this.manualDeadline = at + this.estimator.fullTravel(direction) + 1000;
                if (this.confidence === 'calibrated') this.confidence = 'estimated';
            }
            this.lastDirection = direction;
            if (!this.operation) { this.target = direction === 'opening' ? 100 : 0; this.phase = 'moving'; }
        }
        this.notify('now');
        this.schedule();
    }

    private schedule(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (this.disposed || !this.online) return;
        const op = this.operation;
        if (op?.reached && !op.acknowledged) return;
        const deadline = this.phase === 'stopping' ? undefined : op?.deadline ?? (op ? undefined : this.manualDeadline);
        const remaining = deadline !== undefined ? deadline - this.now()
            : op && this.phase === 'moving' ? this.estimator.remaining(op.target, this.now()) : Infinity;
        if (this.estimator.direction === 'stopped' && remaining === Infinity) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.operation === op && op && (this.phase === 'moving' || this.phase === 'calibrating')) {
                const reached = op.deadline !== undefined ? this.now() >= op.deadline : this.estimator.remaining(op.target, this.now()) <= 0.01;
                if (reached) {
                    this.phase = 'stopping';
                    void this.finish(op).catch(err => this.fail(op, err));
                }
            } else if (!op && this.manualDeadline !== undefined && this.now() >= this.manualDeadline && this.phase !== 'stopping') {
                this.estimator.stop(this.now());
                this.target = this.estimator.position(this.now());
                this.phase = 'idle';
                this.manualDeadline = undefined;
                this.notify('now');
                return;
            }
            this.notify();
            this.schedule();
        }, Math.max(10, Math.min(250, remaining)));
    }

    private async finish(op: Operation): Promise<void> {
        await this.send('stopped', op.id);
        if (this.operation !== op) return;
        if (op.reference) {
            if (this.reportedPosition === undefined) {
                this.estimator.reference(op.target, this.now());
                this.confidence = 'calibrated';
            } else {
                // A timer cannot override a hardware report of unknown position.
                this.confidence = this.reportedPosition === op.target ? 'measured' : 'unknown';
            }
        }
        this.operation = undefined;
        this.phase = 'idle';
        this.target = this.estimator.position(this.now());
        this.notify('now');
        this.schedule();
    }

    private fail(op: Operation, error: unknown): void {
        op.reject(error instanceof Error ? error : new Error(errorMessage(error)));
        if (this.operation !== op) return;
        this.log.warn('[%s] Blind operation failed: %s', this.config.id, errorMessage(error));
        this.operation = undefined;
        this.markFault();
    }

    private markFault(): void {
        this.uncertainMotion ||= this.estimator.direction !== 'stopped';
        this.estimator.stop(this.now());
        this.confidence = 'unknown';
        this.target = this.estimator.position(this.now());
        this.phase = 'fault';
        clearTimeout(this.timer);
        this.timer = undefined;
        this.notify('now');
    }

    destroy(): void {
        if (this.disposed) return;
        this.uncertainMotion ||= this.estimator.direction !== 'stopped';
        if (this.uncertainMotion) this.confidence = 'unknown';
        this.cancel(new BlindError('offline', 'Blind controller stopped'));
        this.estimator.stop(this.now());
        this.notify('now');
        this.disposed = true;
    }
}
