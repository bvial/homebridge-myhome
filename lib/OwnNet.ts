import { EventEmitter } from 'events';
import * as net from 'net';
import { timingSafeEqual } from 'node:crypto';
import { createOwnHmacResponse, type OwnHashAlgorithm } from './OwnAuth';
import type { Logging } from 'homebridge';
import { errorMessage, COMMAND_QUEUE_CAPACITY, COMMAND_TIMEOUT_MS } from './utils';

export const STATE = {
    UNCONNECTED: 'UNCONNECTED',
    CONNECTING: 'CONNECTING',
    LOGGING_IN: 'LOGGING_IN',
    CONNECTED: 'CONNECTED',
} as const;
type StateValue = typeof STATE[keyof typeof STATE];

export const MODE = {
    MONITOR: 'MONITOR',
    COMMAND: 'COMMAND',
    CONFIG: 'CONFIG',
} as const;
export type ModeValue = typeof MODE[keyof typeof MODE];

const DIR = {
    IN: 'IN',
    OUT: 'OUT',
} as const;

export const PKT = {
    ACK: '*#*1##',
    NACK: '*#*0##',
} as const;

export const CMD = {
    START_CONFIG: '*99*0##',
    START_COMMAND: '*99*9##',
    START_MONITOR: '*99*1##',
    SCAN: '*1001*12*0##',
    SCAN_ALL: '*#1001*0*13##',
} as const;

export type CommandFailure = 'timeout' | 'cancelled' | 'expired';

export interface CommandParams {
    command: string;
    stopon?: string | string[];
    packet?: (pkt: string) => void;
    done?: (pkt: string | null, index: number, failure?: CommandFailure) => void;
    started?: () => void;
    /** Commands sharing a key execute in order, even with multiple TCP slots. */
    serialKey?: string;
    priority?: 'stop' | 'background';
    /** Wall-clock deadline for commands that must not execute after a long queue wait. */
    expiresAt?: number;
    /** Rechecked after the TCP handshake, immediately before writing to the bus. */
    shouldSend?: () => boolean;
    /** Cancellation is effective until the packet is written, including the handshake. */
    signal?: AbortSignal;
    log?: Logging;
    id?: string;
}

let idCount = 0;

export function calcPass(pass: string | undefined, nonce: string): string {
    let flag = true; let num1 = 0x0; let num2 = 0x0;
    if (pass === undefined || pass === '' || !/^\d+$/.test(pass)) {
        throw new Error('OWN password must be a non-empty decimal integer string');
    }
    const password = Number(pass);
    if (!Number.isSafeInteger(password) || password > 0xffffffff) throw new Error('Legacy OWN password must fit an unsigned 32-bit integer');
    if (!/^\d+$/.test(nonce)) throw new Error('Legacy OWN nonce must be decimal digits');
    for (const c of nonce) {
        if (c !== '0') {
            if (flag) num2 = password;
            flag = false;
        }
        switch (c) {
            case '1': num1 = num2 & 0xFFFFFF80; num1 = num1 >>> 7; num2 = num2 << 25; num1 = num1 + num2; break;
            case '2': num1 = num2 & 0xFFFFFFF0; num1 = num1 >>> 4; num2 = num2 << 28; num1 = num1 + num2; break;
            case '3': num1 = num2 & 0xFFFFFFF8; num1 = num1 >>> 3; num2 = num2 << 29; num1 = num1 + num2; break;
            case '4': num1 = num2 << 1; num2 = num2 >>> 31; num1 = num1 + num2; break;
            case '5': num1 = num2 << 5; num2 = num2 >>> 27; num1 = num1 + num2; break;
            case '6': num1 = num2 << 12; num2 = num2 >>> 20; num1 = num1 + num2; break;
            case '7': num1 = num2 & 0x0000FF00; num1 = num1 + ((num2 & 0x000000FF) << 24); num1 = num1 + ((num2 & 0x00FF0000) >>> 16); num2 = (num2 & 0xFF000000) >>> 8; num1 = num1 + num2; break;
            case '8': num1 = num2 & 0x0000FFFF; num1 = num1 << 16; num1 = num1 + (num2 >>> 24); num2 = num2 & 0x00FF0000; num2 = num2 >>> 8; num1 = num1 + num2; break;
            case '9': num1 = ~num2; break;
            case '0': num1 = num2; break;
        }
        num2 = num1;
    }
    return (num1 >>> 0).toString();
}

export class OwnConnection extends EventEmitter {
    id: string;
    host: string;
    port: number;
    password: string;
    conn: net.Socket | null;
    buf: string;
    state: StateValue;
    mode: ModeValue;
    log: Logging;
    private hmac?: { algorithm: OwnHashAlgorithm; serverProof?: string };
    private ended = false;

    constructor(host: string, port: string | number, password: string, mode: ModeValue, log: Logging) {
        super();
        idCount++;
        this.id = idCount.toString();
        this.host = host;
        this.port = parseInt(String(port), 10);
        this.password = password;
        this.conn = null;
        this.buf = '';
        this.state = STATE.UNCONNECTED;
        this.mode = mode;
        this.log = log;
    }

    private destroyConn(): void {
        if (this.conn) {
            this.ended = true;
            this.conn.removeAllListeners();
            this.conn.on('error', () => {});
            this.conn.destroy();
            this.conn = null;
            this.state = STATE.UNCONNECTED;
            this.emit('close');
        }
    }

    connect(): void {
        if (this.conn) {
            this.log.debug('conn:%s destroy old socket', this.id);
            this.destroyConn();
        }
        this.buf = '';
        this.hmac = undefined;
        this.ended = false;
        this.log.debug('conn:%s open socket host: %s, port:%s ', this.id, this.host, this.port);
        this.conn = net.connect({ host: this.host, port: this.port });
        this.conn.setKeepAlive(true, 30000);
        // Disable Nagle's algorithm: OWN packets are tiny and latency-sensitive. A delayed
        // STOP (*2*0*) echo lets the local position timer over-count during blind movements,
        // so shaving the ~40 ms Nagle delay reduces manual-movement position drift.
        this.conn.setNoDelay(true);
        this.conn.on('data', this.onData.bind(this));
        this.conn.on('error', (error: Error) => {
            this.log.error('Socket error: %s', error.message);
            this.state = STATE.UNCONNECTED;
        });
        // Peer half-close: the gateway sent FIN but not RST. Without this handler Node would
        // leave the socket in read-only mode indefinitely. Tear the socket down AND notify
        // subscribers via 'close'.
        this.conn.on('end', () => {
            this.log.debug('conn:%s peer half-closed connection (FIN)', this.id);
            this.destroyConn();
        });
        this.conn.on('close', () => {
            this.ended = true;
            this.state = STATE.UNCONNECTED;
            const socket = this.conn;
            this.conn = null;
            if (socket) {
                socket.removeAllListeners();
                socket.on('error', () => {});
            }
            this.emit('close');
        });
    }

    setTimeout(time: number): void {
        if (this.conn) {
            this.conn.removeAllListeners('timeout');
            this.conn.setTimeout(time);
            this.conn.once('timeout', () => {
                this.log.debug('conn:%s socket timeout', this.id);
                this.end();
            });
        }
    }

    end(): void {
        this.ended = true;
        if (this.conn) {
            this.log.debug('conn:%s end', this.id);
            this.destroyConn();
        }
    }

    logPacket(direction: string, packet: string): void {
        if (this.state === STATE.CONNECTING || this.state === STATE.LOGGING_IN) {
            this.log.debug('conn:%s mode:%s dir:%s data:[auth]', this.id, this.mode, direction);
        } else {
            this.log.debug('conn:%s mode:%s dir:%s data:%s', this.id, this.mode, direction, packet);
        }
    }

    sendPacket(packet: string): void {
        this.logPacket(DIR.OUT, packet);
        if (this.conn) this.conn.write(packet);
    }

    onData(data: Buffer | string): void {
        if (this.ended) return;
        this.buf += data.toString();

        while (!this.ended && this.buf.length > 0) {
            // Discard any leading characters prior to the start of a packet ('*')
            const startIdx = this.buf.indexOf('*');
            if (startIdx > 0) {
                this.buf = this.buf.slice(startIdx);
            } else if (startIdx === -1) {
                this.buf = '';
                break;
            }

            const m = this.buf.match(/^(\*.+?##)([\s\S]*)$/);
            if (!m) {
                if (this.buf.length > 4096) {
                    this.log.warn('conn:%s buffer overflow (%d bytes), discarding', this.id, this.buf.length);
                    this.buf = '';
                }
                break;
            }
            const packet = m[1];
            this.buf = m[2];

            this.logPacket(DIR.IN, packet);
            switch (this.state) {
                case STATE.UNCONNECTED:
                    if (packet === PKT.ACK) {
                        this.emit('connecting');
                        this.state = STATE.CONNECTING;
                        this.log.debug('conn:%s new connection', this.id);
                        switch (this.mode) {
                            case MODE.MONITOR: this.sendPacket(CMD.START_MONITOR); break;
                            case MODE.COMMAND: this.sendPacket(CMD.START_COMMAND); break;
                            case MODE.CONFIG: this.sendPacket(CMD.START_CONFIG); break;
                        }
                    }
                    break;
                case STATE.CONNECTING:
                    if (packet === PKT.ACK) {
                        this.state = STATE.CONNECTED;
                        this.emit('connected');
                        this.log.debug('conn:%s start unauthenticated connection', this.id);
                    } else if (packet === PKT.NACK) {
                        this.log.error('conn:%s Gateway rejected session type (NACK) — gateway may be busy or out of slots', this.id);
                        this.state = STATE.UNCONNECTED;
                        this.end();
                    } else if (packet === '*98*1##' || packet === '*98*2##') {
                        this.hmac = { algorithm: packet === '*98*1##' ? 'sha1' : 'sha256' };
                        this.state = STATE.LOGGING_IN;
                        this.sendPacket(PKT.ACK);
                    } else if (packet.startsWith('*98*')) {
                        this.failAuthentication('Unsupported gateway authentication algorithm');
                        return;
                    } else {
                        const loginMatch = packet.match(/^\*#(\d+)##$/);
                        if (loginMatch === null) {
                            this.log.error("conn:%s Unable to recognize packet '%s'", this.id, packet);
                        } else {
                            this.emit('logging-in');
                            this.log.debug('conn:%s send password', this.id);
                            try {
                                const p = calcPass(this.password, loginMatch[1]);
                                this.state = STATE.LOGGING_IN;
                                if (this.conn) this.conn.write(`*#${p}##`);
                            } catch (err) {
                                this.log.error('conn:%s Password error: %s', this.id, errorMessage(err));
                                this.state = STATE.UNCONNECTED;
                                this.emit('auth-failed');
                                this.end();
                                return;
                            }
                        }
                    }
                    break;
                case STATE.LOGGING_IN:
                    if (this.hmac) {
                        const frame = packet.match(/^\*#(\d+)##$/);
                        try {
                            if (!frame) throw new Error('Gateway rejected HMAC authentication or returned an invalid frame');
                            if (!this.hmac.serverProof) {
                                const response = createOwnHmacResponse(this.password, frame[1], this.hmac.algorithm);
                                this.hmac.serverProof = response.serverProof;
                                this.sendPacket(response.packet);
                            } else {
                                const actual = Buffer.from(frame[1]);
                                const expected = Buffer.from(this.hmac.serverProof);
                                if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Gateway HMAC proof verification failed');
                                this.sendPacket(PKT.ACK);
                                this.hmac = undefined;
                                this.state = STATE.CONNECTED;
                                this.emit('connected');
                            }
                        } catch (err) {
                            this.failAuthentication(errorMessage(err));
                            return;
                        }
                        break;
                    }
                    if (packet === PKT.ACK) {
                        this.state = STATE.CONNECTED;
                        this.emit('connected');
                        this.log.debug('conn:%s start authenticated connection', this.id);
                    } else if (packet === PKT.NACK) {
                        this.log.error('conn:%s Authentication failed (wrong password)', this.id);
                        this.state = STATE.UNCONNECTED;
                        this.emit('auth-failed');
                        this.end();
                        return;
                    } else {
                        this.log.error('conn:%s Got unexpected packet in login phase', this.id);
                    }
                    break;
                case STATE.CONNECTED:
                    this.emit('packet', packet);
                    break;
            }
        }
    }

    private failAuthentication(message: string): void {
        this.log.error('conn:%s %s', this.id, message);
        this.sendPacket(PKT.NACK);
        this.hmac = undefined;
        this.state = STATE.UNCONNECTED;
        this.emit('auth-failed');
        this.end();
    }
}

export class OwnMonitor extends EventEmitter {
    client: OwnClient;
    connection: OwnConnection | null;
    checkTimeout: NodeJS.Timeout | undefined;
    reconnectTimeout: NodeJS.Timeout | undefined;
    nbCheck: number;
    reconnectSeconds: number;
    reconnectAttempts: number;
    authFailed: boolean;
    /** True while a keep-alive probe is in flight — prevents parallel probes
     *  when a delayed `done` callback overlaps with the next checkTimeout tick.
     *  Non-private: asserted by the test suite. */
    checkInFlight: boolean;
    private stopped = false;

    constructor(client: OwnClient) {
        super();
        this.client = client;
        this.connection = null;
        this.checkTimeout = undefined;
        this.reconnectTimeout = undefined;
        this.nbCheck = 0;
        this.reconnectSeconds = 30;
        this.reconnectAttempts = 0;
        this.authFailed = false;
        this.checkInFlight = false;
    }

    private closeConnection(): void {
        if (this.connection !== null) {
            this.connection.removeAllListeners();
            this.connection.end();
            this.connection = null;
        }
    }

    connect(): void {
        if (this.stopped) return;
        this.nbCheck = 0;
        this.checkInFlight = false;
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
        this.client.log.info('Start monitoring MyHome server');
        this.closeConnection();
        this.connection = this.client.newConnection(MODE.MONITOR);
        this.connection.on('connected', () => {
            this.reconnectAttempts = 0;
            this.authFailed = false;
            this.emit('connected');
        });
        this.connection.on('auth-failed', () => {
            this.authFailed = true;
            this.emit('auth-failed');
        });
        this.connection.on('close', () => {
            this.emit('close');
        });
        this.connection.on('packet', (data: string) => {
            this.resetAutoConnectTimeout();
            this.emit('packet', data);
        });
        this.connection.connect();
        this.resetCheck();
        this.resetAutoConnectTimeout();
    }

    /** Dispatch a keep-alive probe. Returns true if a probe was actually sent this tick,
     *  false if it was skipped (previous probe still in flight) or dropped (queue full) —
     *  the caller uses this to avoid counting a non-dispatched tick as a failed check. */
    checkMonitor(): boolean {
        if (this.stopped) return false;
        if (this.checkInFlight) {
            // A previous probe hasn't resolved yet — skip this tick to avoid
            // stacking parallel `*#13**15##` commands on the queue.
            this.client.log.debug('Monitor: skipping keep-alive probe, previous one still in flight');
            return false;
        }
        this.checkInFlight = true;
        const queued = this.client.sendCommand({
            command: '*#13**15##',
            stopon: PKT.ACK,
            done: (pkt: string | null) => {
                // A queued probe may complete after stop() has disposed this monitor.
                if (this.stopped) return;
                this.checkInFlight = false;
                if (pkt === PKT.ACK) {
                    const connAlive = this.connection !== null && this.connection.state === STATE.CONNECTED;
                    if (!connAlive) {
                        this.client.log.warn('Monitor: keep-alive OK but monitor disconnected, reconnecting now');
                        this.reconnectAttempts++;
                        this.connect();
                    } else {
                        this.client.log.debug('Monitor: keep-alive acknowledged, connection healthy');
                        this.resetCheck();
                        this.resetAutoConnectTimeout();
                    }
                } else {
                    // Probe timed out or command queue dropped the packet: leave nbCheck as-is
                    // so the next checkTimeout tick counts as another failed probe. Do NOT
                    // reset the timer here — the outer resetAutoConnectTimeout() armed by
                    // restartConnection() will fire again after reconnectSeconds.
                    this.client.log.debug('Monitor: keep-alive probe timed out or failed to send');
                }
            },
        });
        if (!queued) {
            // Queue was full: sendCommand dropped the probe and will never invoke `done`.
            // Reset the in-flight flag now, otherwise every future checkMonitor() tick would
            // short-circuit at the guard above and keep-alive probes would stop forever.
            this.checkInFlight = false;
            this.client.log.debug('Monitor: keep-alive probe not queued (queue full)');
            return false;
        }
        return true;
    }

    resetCheck(): void {
        this.nbCheck = 0;
    }

    resetAutoConnectTimeout(): void {
        if (this.stopped) return;
        if (this.checkTimeout !== undefined) clearTimeout(this.checkTimeout);
        this.checkTimeout = setTimeout(this.restartConnection.bind(this), this.reconnectSeconds * 1000);
    }

    restartConnection(): void {
        if (this.stopped) return;
        if (this.authFailed) {
            this.client.log.error('Monitor: authentication failed, not reconnecting (check password)');
            this.emit('auth-failed');
            return;
        }
        if (this.nbCheck < 3) {
            // Only count a tick toward the dead-connection threshold if a probe was actually
            // dispatched. A tick skipped because the previous probe is still in flight (slow
            // gateway) must not push us toward a spurious reconnect.
            if (this.checkMonitor()) {
                this.nbCheck++;
            }
            this.resetAutoConnectTimeout();
        } else {
            clearTimeout(this.checkTimeout);
            this.checkTimeout = undefined;
            this.reconnectAttempts++;
            const delaySec = Math.min(this.reconnectSeconds * this.reconnectAttempts, 300);
            this.client.log.error('Monitor connection is dead, reconnecting in %ds (attempt #%d)', delaySec, this.reconnectAttempts);
            this.reconnectTimeout = setTimeout(() => this.connect(), delaySec * 1000);
        }
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.checkTimeout);
        clearTimeout(this.reconnectTimeout);
        this.checkTimeout = undefined;
        this.reconnectTimeout = undefined;
        this.checkInFlight = false;
        this.closeConnection();
        this.removeAllListeners();
    }
}

export class OwnClient extends EventEmitter {
    host: string;
    password: string;
    port: string | number;
    monitor: OwnMonitor | null;
    log: Logging;
    commandQueue: CommandParams[];
    activeCommands: number;
    maxConcurrent: number;
    private destroyed = false;
    private authenticationBlocked = false;
    private readonly cancelActiveCommands = new Set<() => void>();
    private readonly activeKeys = new Set<string>();
    private queueTimer?: ReturnType<typeof setTimeout>;
    private readonly queuedAborts = new Map<CommandParams, () => void>();

    constructor(host: string, port: string | number, password: string, log: Logging) {
        super();
        this.host = host;
        this.password = password;
        this.port = port;
        this.monitor = null;
        this.log = log;
        this.commandQueue = [];
        this.activeCommands = 0;
        this.maxConcurrent = 2;
    }

    newConnection(mode: ModeValue, log?: Logging): OwnConnection {
        return new OwnConnection(this.host, this.port, this.password, mode, log || this.log);
    }

    queueSize(): number {
        return this.commandQueue.length;
    }

    sendCommand(params: CommandParams): boolean {
        if (this.destroyed || this.authenticationBlocked) return false;
        if (params.signal?.aborted) {
            this.rejectQueued(params, 'cancelled');
            return true;
        }
        const capacity = COMMAND_QUEUE_CAPACITY + (params.priority === 'stop' ? 10 : 0);
        if (this.commandQueue.length >= capacity) {
            this.log.warn('Command queue full (%d), dropping: %s', this.commandQueue.length, params.command);
            return false;
        }
        this.commandQueue.push(params);
        if (params.signal) {
            const signal = params.signal;
            const abort = () => {
                const index = this.commandQueue.indexOf(params);
                if (index === -1) return;
                this.commandQueue.splice(index, 1);
                this.rejectQueued(params, 'cancelled');
                this.processQueue();
            };
            signal.addEventListener('abort', abort, { once: true });
            this.queuedAborts.set(params, () => signal.removeEventListener('abort', abort));
        }
        this.processQueue();
        return true;
    }

    processQueue(): void {
        clearTimeout(this.queueTimer);
        this.queueTimer = undefined;
        const expired = this.commandQueue.filter(p => p.expiresAt !== undefined && p.expiresAt <= Date.now());
        this.commandQueue = this.commandQueue.filter(p => !expired.includes(p));
        for (const params of expired) this.rejectQueued(params, 'expired');
        while (!this.destroyed && !this.authenticationBlocked && this.activeCommands < this.maxConcurrent && this.commandQueue.length > 0) {
            const score = (p: CommandParams) => p.priority === 'stop' ? 2 : p.priority === 'background' ? 0 : 1;
            let index = -1;
            for (let i = 0; i < this.commandQueue.length; i++) {
                const params = this.commandQueue[i];
                if (params.serialKey && (this.activeKeys.has(params.serialKey)
                    || this.commandQueue.slice(0, i).some(p => p.serialKey === params.serialKey))) continue;
                if (index === -1 || score(params) > score(this.commandQueue[index])) index = i;
            }
            if (index === -1) break;
            const [params] = this.commandQueue.splice(index, 1);
            this.detachQueuedAbort(params);
            this.activeCommands++;
            if (params.serialKey) this.activeKeys.add(params.serialKey);
            this.executeCommand(params);
        }
        const deadlines = this.commandQueue.flatMap(p => p.expiresAt === undefined ? [] : [p.expiresAt]);
        clearTimeout(this.queueTimer);
        this.queueTimer = undefined;
        if (!this.destroyed && deadlines.length) {
            this.queueTimer = setTimeout(() => this.processQueue(), Math.max(1, Math.min(...deadlines) - Date.now()));
        }
    }

    /** Cancel only queued work. Already-written commands require a subsequent STOP. */
    cancelQueued(serialKey: string): void {
        const removed = this.commandQueue.filter(p => p.serialKey === serialKey);
        this.commandQueue = this.commandQueue.filter(p => p.serialKey !== serialKey);
        for (const params of removed) this.rejectQueued(params, 'cancelled');
        this.processQueue();
    }

    private rejectQueued(params: CommandParams, failure: CommandFailure): void {
        this.detachQueuedAbort(params);
        try { params.done?.(null, -1, failure); } catch (err) {
            this.log.error('Command callback failed: %s', errorMessage(err));
        }
    }

    private detachQueuedAbort(params: CommandParams): void {
        this.queuedAborts.get(params)?.();
        this.queuedAborts.delete(params);
    }

    releaseSlot(): void {
        if (this.activeCommands > 0) this.activeCommands--;
        this.processQueue();
    }

    executeCommand(params: CommandParams): void {
        if (this.destroyed) {
            this.releaseSlot();
            params.done?.(null, -1);
            return;
        }
        let finished = false;
        let sent = false;
        let commandconn: OwnConnection | undefined;
        let cmdTimeout: ReturnType<typeof setTimeout> | undefined;
        const cancel = () => finish(null, -1);
        const abort = () => { if (!sent) finish(null, -1, 'cancelled'); };
        const finish = (packet: string | null, index: number, failure?: CommandFailure) => {
            if (finished) return;
            // end() emits close synchronously. Settle first so that close, a timeout,
            // or a late packet cannot release another command's slot or call done twice.
            finished = true;
            clearTimeout(cmdTimeout);
            params.signal?.removeEventListener('abort', abort);
            this.cancelActiveCommands.delete(cancel);
            try {
                commandconn?.end();
            } finally {
                if (this.activeCommands > 0) this.activeCommands--;
                try {
                    // Commit the result before dispatching another command for this device.
                    params.done?.(packet, index, failure);
                } finally {
                    if (params.serialKey) this.activeKeys.delete(params.serialKey);
                    this.processQueue();
                }
            }
        };
        this.cancelActiveCommands.add(cancel);
        params.signal?.addEventListener('abort', abort, { once: true });
        if (params.signal?.aborted) { abort(); return; }

        try {
            const connection = this.newConnection(MODE.COMMAND, params.log);
            commandconn = connection;
            // Arm overall timeout right away so connection hangs or unhandled stalls don't freeze the queue
            cmdTimeout = setTimeout(() => {
                connection.log.debug('conn:%s command timeout', connection.id);
                finish(null, -1, 'timeout');
            }, COMMAND_TIMEOUT_MS);

            connection.on('connected', () => {
                if (finished) return;
                if (params.shouldSend && !params.shouldSend()) return finish(null, -1, 'cancelled');
                if (params.expiresAt !== undefined && params.expiresAt <= Date.now()) return finish(null, -1, 'expired');
                params.started?.();
                if (finished) return;
                sent = true;
                connection.sendPacket(params.command);
            });
            connection.on('packet', (packet: string) => {
                if (finished) return;

                if (params.stopon !== undefined) {
                    if (Array.isArray(params.stopon)) {
                        const i = params.stopon.indexOf(packet);
                        if (i !== -1) return finish(packet, i);
                    } else if (packet === params.stopon) {
                        return finish(packet, 0);
                    }
                } else if (packet === PKT.ACK) {
                    return finish(packet, 0);
                }
                // A rejection is terminal even when the caller only expects ACK.
                // Explicit NACK stop conditions above keep their requested index.
                if (packet === PKT.NACK) return finish(null, -1);
                if (params.packet) params.packet(packet);
            });
            connection.on('auth-failed', () => this.blockAuthentication());
            connection.on('close', () => finish(null, -1));
            connection.connect();
        } catch (err) {
            this.log.error('executeCommand failed synchronously: %s', errorMessage(err));
            finish(null, -1);
        }
    }

    startMonitor(): void {
        if (this.destroyed || this.authenticationBlocked) return;
        this.monitor = new OwnMonitor(this);
        this.monitor.on('connected', () => {
            this.emit('monitoring');
        });
        this.monitor.on('auth-failed', () => {
            this.blockAuthentication();
        });
        this.monitor.on('packet', (data: string) => {
            this.emit('packet', data);
        });
        this.monitor.on('close', () => {
            this.emit('unmonitoring');
        });
        this.monitor.connect();
    }

    stopMonitor(): void {
        if (this.monitor) {
            this.monitor.stop();
            this.monitor = null;
        }
        // Note: do NOT call this.removeAllListeners() here — OwnPlatform attaches
        // 'packet'/'monitoring'/'unmonitoring'/'auth-failed' listeners on the OwnClient
        // instance and would lose them across reconnects.
    }

    private blockAuthentication(): void {
        if (this.authenticationBlocked || this.destroyed) return;
        this.authenticationBlocked = true;
        this.stopMonitor();
        clearTimeout(this.queueTimer);
        const queued = this.commandQueue.splice(0);
        for (const params of queued) {
            this.detachQueuedAbort(params);
            try { params.done?.(null, -1); } catch (err) {
                this.log.error('Command callback failed after authentication failure: %s', errorMessage(err));
            }
        }
        for (const cancel of this.cancelActiveCommands) {
            try { cancel(); } catch (err) {
                this.log.error('Command cleanup failed after authentication failure: %s', errorMessage(err));
            }
        }
        this.emit('auth-failed');
    }

    /** Permanently close this client, including command sockets and pending scans. */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        clearTimeout(this.queueTimer);
        this.stopMonitor();
        const queued = this.commandQueue.splice(0);
        // Settle every accepted command so callers waiting for a scan can finish.
        // Callbacks may enqueue more work or throw; neither may interrupt cleanup.
        for (const params of queued) {
            this.detachQueuedAbort(params);
            try { params.done?.(null, -1); } catch (err) {
                this.log.error('Command callback failed during shutdown: %s', errorMessage(err));
            }
        }
        for (const cancel of this.cancelActiveCommands) {
            try { cancel(); } catch (err) {
                this.log.error('Command cleanup failed during shutdown: %s', errorMessage(err));
            }
        }
        this.removeAllListeners();
    }

    detectGatewayModel(callback: (model: string | null) => void): void {
        const collected: string[] = [];
        this.sendCommand({
            command: '*#13**15##',  // DIM 15 = Device Type (numeric model code)
            stopon: [PKT.ACK, PKT.NACK],
            packet: (pkt) => { collected.push(pkt); },
            done: (pkt) => {
                if (pkt === null || pkt === PKT.NACK) {
                    this.log.warn('detectGatewayModel: command failed or timed out (model unknown)');
                    callback(null);
                    return;
                }
                this.log.debug('detectGatewayModel: collected packets: %s', JSON.stringify(collected));
                for (const p of collected) {
                    const m = p.match(/^\*#13\*\*15\*(\d+)##$/);
                    if (m) {
                        this.log.info('detectGatewayModel: gateway model code: %s', m[1]);
                        callback(m[1]);
                        return;
                    }
                }
                this.log.warn('detectGatewayModel: gateway did not return a model code (got ACK with no data packets)');
                callback(null);
            },
        });
    }
}
