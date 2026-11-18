import type { API, Logging, MatterAccessory, MatterAPI } from 'homebridge';
import type { DeviceCommand, DeviceCommandOptions, DeviceEvent, DeviceKind, DeviceState, OwnDevice } from './OwnDevice';
import { PLUGIN_NAME, PLATFORM_NAME, PLUGIN_VERSION } from './constants';
import { errorMessage } from './utils';

export interface MatterDeviceEntry {
    UUID: string;
    kind: DeviceKind;
    config: Record<string, unknown>;
    device: OwnDevice;
    context: Record<string, unknown>;
}

type ClusterStates = Record<string, Record<string, unknown>>;
type MatterMode = 'heat' | 'cool' | 'both';
interface Projection { clusters: ClusterStates; parts: Map<string, ClusterStates> }
interface LiveDevice {
    entry: MatterDeviceEntry;
    accessory: MatterAccessory;
    signature: string;
    active: boolean;
    ready: boolean;
    unsubscribe?: () => void;
    pending?: DeviceState;
    timer?: ReturnType<typeof setTimeout>;
    dimmerTimer?: ReturnType<typeof setInterval>;
    dimmerLevel?: number;
    dimmerGeneration: number;
    dimmerAbort?: AbortController;
    chain: Promise<void>;
    lastSent: Map<string, string>;
    correctionRevision: number;
    contextJSON: string;
    manualMode: 'heat' | 'cool';
    thermostatEcho?: Record<string, unknown>;
}

const finite = (value: number | undefined, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const position = (value: number | undefined): number => Math.round((100 - clamp(finite(value, 0), 0, 100)) * 100);
const temperature = (value: number | undefined): number => Math.round(clamp(finite(value, 20), 5, 30) * 100);
const level = (value: number | undefined): number => Math.max(1, Math.round(clamp(finite(value, 100), 0, 100) * 254 / 100));
const descriptorSignature = (kind: unknown, config: Record<string, unknown>): string =>
    JSON.stringify([kind, !!config.dimmer, config.sensorType ?? 'contact', !!config.doorbell, config.matterMode ?? 'heat',
        ...(kind === 'blind' && (config.calibrationSwitch || config.calibration === 'manual') ? ['calibration'] : [])]);
const matterText = (value: string, maxBytes = 32): string => {
    let result = '';
    for (const character of value) {
        if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
        result += character;
    }
    return result;
};

/** Publishes one Matter view of each existing MyHome device controller. */
export class OwnMatterBridge {
    private readonly matter: MatterAPI | undefined;
    private readonly restoresComposedTypes: boolean;
    private readonly cached = new Map<string, MatterAccessory>();
    private readonly live = new Map<string, LiveDevice>();
    // Endpoint reconstruction can succeed at unregistering but fail at registering.
    // Keep device context independently until the replacement is ready.
    private readonly retainedContexts = new Map<string, Record<string, unknown>>();
    private stopped = false;
    private syncChain: Promise<void> = Promise.resolve();

    constructor(api: API, private readonly log: Logging) {
        this.matter = api.matter;
        this.restoresComposedTypes = api.versionGreaterOrEqual?.('2.5.0') ?? false;
    }

    configureAccessory(accessory: MatterAccessory): void {
        this.cached.set(accessory.UUID, accessory);
    }

    /** Serialize reconciliation so discovery and configuration refreshes cannot race. */
    sync(entries: MatterDeviceEntry[]): Promise<void> {
        this.syncChain = this.syncChain.catch(() => {}).then(() => this.reconcile(entries));
        return this.syncChain;
    }

    private async reconcile(entries: MatterDeviceEntry[]): Promise<void> {
        if (this.stopped || !this.matter) return;
        const desired = new Map(entries.map(entry => [entry.UUID, entry]));
        for (const id of this.retainedContexts.keys()) if (!desired.has(id)) this.retainedContexts.delete(id);
        const stale = new Map(this.cached);
        for (const [id, record] of this.live) stale.set(id, record.accessory);
        for (const id of desired.keys()) stale.delete(id);
        for (const [id, accessory] of stale) {
            const record = this.live.get(id);
            if (record) { this.dispose(record); await record.chain; }
            if (this.stopped) return;
            await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.live.delete(id);
            this.cached.delete(id);
        }

        for (const entry of desired.values()) {
            if (this.stopped) return;
            const signature = descriptorSignature(entry.kind, entry.config);
            const previous = this.live.get(entry.UUID);
            if (previous?.active && previous.entry.device === entry.device && previous.signature === signature) {
                previous.entry = entry;
                this.queueState(previous, entry.device.snapshot());
                continue;
            }
            // Rebuilding an endpoint must not discard its persisted device state.
            const previousContext = previous ? { ...previous.accessory.context, manualMode: previous.manualMode }
                : this.cached.get(entry.UUID)?.context ?? this.retainedContexts.get(entry.UUID);
            if (previousContext) this.retainedContexts.set(entry.UUID, previousContext);
            const rememberedMode = previousContext?.manualMode;
            if (previous) {
                this.dispose(previous);
                await previous.chain;
                await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [previous.accessory]);
                this.live.delete(entry.UUID);
                this.cached.delete(entry.UUID);
            }
            if (this.stopped) return;
            const cached = this.cached.get(entry.UUID);
            if (cached) {
                const context = cached.context as { kind?: unknown; matterSignature?: string; deviceContext?: { type?: unknown; device?: Record<string, unknown> } } | undefined;
                const cachedSignature = context?.matterSignature ?? descriptorSignature(context?.kind ?? context?.deviceContext?.type, context?.deviceContext?.device ?? {});
                // Homebridge 2.5 restores composed features in place. Older
                // versions need reconstruction; custom LevelControl classes
                // still need it on all versions to reattach their device hooks.
                const rebuild = (entry.kind === 'light' && entry.config.dimmer)
                    || (!this.restoresComposedTypes && (entry.kind === 'thermostat'
                        || (entry.kind === 'contact' && entry.config.sensorType === 'occupancy')));
                if (signature !== cachedSignature || rebuild) {
                    await this.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cached]);
                    this.cached.delete(entry.UUID);
                }
            }
            if (this.stopped) return;
            const record = this.createRecord(entry, signature, rememberedMode);
            this.retainedContexts.set(entry.UUID, record.accessory.context);
            this.live.set(entry.UUID, record);
            try {
                await this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [record.accessory]);
                this.cached.set(entry.UUID, record.accessory);
                if (this.stopped || !record.active) return;
                record.ready = true;
                this.retainedContexts.delete(entry.UUID);
                record.unsubscribe = entry.device.subscribe(event => this.onEvent(record, event));
                this.queueState(record, entry.device.snapshot());
            } catch (err) {
                this.dispose(record);
                this.live.delete(entry.UUID);
                this.log.error('[Matter] Failed to register %s: %s', entry.UUID, errorMessage(err));
            }
        }
    }

    private createRecord(entry: MatterDeviceEntry, signature: string, rememberedMode?: unknown): LiveDevice {
        const initial = entry.device.snapshot();
        const manualMode = initial.mode === 'heat' || initial.mode === 'cool' ? initial.mode
            : rememberedMode === 'cool' || entry.config.matterMode === 'cool' ? 'cool' : 'heat';
        const record: LiveDevice = {
            entry, signature, active: true, ready: false, chain: Promise.resolve(),
            lastSent: new Map(), contextJSON: '', manualMode, dimmerGeneration: 0, correctionRevision: 0,
            accessory: {
                UUID: entry.UUID, displayName: matterText(initial.name || 'MyHome'),
                manufacturer: 'Legrand / BTicino', model: `MyHome ${entry.kind}`,
                serialNumber: matterText(entry.UUID.replace(/-/g, '')), firmwareRevision: PLUGIN_VERSION,
                context: { kind: entry.kind, deviceContext: { ...entry.context }, manualMode, matterSignature: signature },
                deviceType: this.matter!.deviceTypes.OnOffOutlet,
            },
        };
        this.configureDescriptor(record);
        const projected = this.project(record, initial);
        record.accessory.clusters = projected.clusters;
        for (const part of record.accessory.parts ?? []) part.clusters = projected.parts.get(part.id) ?? {};
        return record;
    }

    private matterMode(record: LiveDevice): MatterMode {
        const value = record.entry.config.matterMode;
        return value === 'cool' || value === 'both' ? value : 'heat';
    }

    private configureDescriptor(record: LiveDevice): void {
        const matter = this.matter!;
        const types = matter.deviceTypes;
        const accessory = record.accessory;
        const entry = record.entry;
        const run = (command: DeviceCommand) => this.command(record, command);
        accessory.handlers = { identify: { identify: args => { if (args?.identifyTime) return run({ type: 'identify' }); } } };
        switch (entry.kind) {
            case 'light':
                accessory.deviceType = entry.config.dimmer ? types.DimmableLight : types.OnOffLight;
                accessory.handlers.onOff = {
                    on: () => { this.stopDimming(record); return run({ type: 'power', value: true }); },
                    off: () => { this.stopDimming(record); return run({ type: 'power', value: false }); },
                    toggle: () => { this.stopDimming(record); return run({ type: 'power', value: !entry.device.snapshot().on }); },
                };
                if (entry.config.dimmer) {
                    accessory.deviceType = this.dimmerType(record);
                }
                break;
            case 'blind':
                accessory.deviceType = types.WindowCovering;
                accessory.handlers.windowCovering = {
                    upOrOpen: () => run({ type: 'position', value: 100 }),
                    downOrClose: () => run({ type: 'position', value: 0 }),
                    stopMotion: () => run({ type: 'stop' }),
                    goToLiftPercentage: args => run({ type: 'position', value: Math.round(100 - this.numberInRange(args?.liftPercent100thsValue, 0, 10000) / 100) }),
                };
                if (entry.config.calibrationSwitch || entry.config.calibration === 'manual') {
                    accessory.parts = [{
                        id: 'calibration', displayName: matterText(`${accessory.displayName} Calibration`, 64), deviceType: types.OnOffOutlet, clusters: {},
                        handlers: { onOff: {
                            on: () => run({ type: 'calibrate' }),
                            off: () => {
                                this.assertUsable(record);
                                if (entry.device.snapshot().calibrating) return run({ type: 'stop' });
                                this.queueState(record, entry.device.snapshot(), true);
                            },
                            toggle: () => run({ type: entry.device.snapshot().calibrating ? 'stop' : 'calibrate' }),
                        } },
                    }];
                }
                break;
            case 'thermostat': {
                const mode = this.matterMode(record);
                const requirement = matter.deviceRequirements.Thermostat.ThermostatServer;
                accessory.deviceType = types.Thermostat.with(mode === 'both' ? requirement.with('Heating', 'Cooling') : requirement.with(mode === 'cool' ? 'Cooling' : 'Heating'));
                accessory.handlers.thermostat = {
                    systemModeChange: args => {
                        const requested = args?.systemMode;
                        if (typeof requested === 'number' && record.thermostatEcho?.systemMode === requested) return;
                        if (requested === 0) return run({ type: 'mode', value: 'off' });
                        if (requested === 4 && mode !== 'cool') return run({ type: 'mode', value: 'heat' });
                        if (requested === 3 && mode !== 'heat') return run({ type: 'mode', value: 'cool' });
                        this.queueState(record, entry.device.snapshot(), true);
                        throw this.protocolError('InvalidAction', 'MyHome programmes are controlled by the separate programme switch');
                    },
                    ...(mode !== 'cool' ? { occupiedHeatingSetpointChange: args => this.setTemperature(record, args?.occupiedHeatingSetpoint, 'heat') } : {}),
                    ...(mode !== 'heat' ? { occupiedCoolingSetpointChange: args => this.setTemperature(record, args?.occupiedCoolingSetpoint, 'cool') } : {}),
                    setpointRaiseLower: args => {
                        const state = entry.device.snapshot();
                        const requestedMode = args?.mode;
                        const selected = requestedMode === 0 ? 'heat' : requestedMode === 1 ? 'cool' : state.mode;
                        if ((selected !== 'heat' && selected !== 'cool') || (requestedMode !== 0 && requestedMode !== 1 && requestedMode !== 2)) {
                            throw this.protocolError('InvalidInState', 'Choose manual heating or cooling before changing its setpoint');
                        }
                        return this.setTemperature(record, temperature(state.targetTemperature) + this.numberInRange(args?.amount, -128, 127) * 10, selected);
                    },
                };
                accessory.parts = [{
                    id: 'programme', displayName: matterText(`${accessory.displayName} Programme automatique`, 64), deviceType: types.OnOffOutlet, clusters: {},
                    handlers: { onOff: {
                        on: () => run({ type: 'mode', value: 'auto' }),
                        off: () => {
                            if (entry.device.snapshot().mode === 'auto') return run({ type: 'mode', value: record.manualMode });
                            this.assertUsable(record);
                            this.queueState(record, entry.device.snapshot(), true);
                        },
                        toggle: () => run({ type: 'mode', value: entry.device.snapshot().mode === 'auto' ? record.manualMode : 'auto' }),
                    } },
                }];
                break;
            }
            case 'contact': {
                const kind = entry.config.sensorType;
                if (kind === 'motion') accessory.deviceType = types.MotionSensor;
                else if (kind === 'occupancy') accessory.deviceType = types.MotionSensor.with(matter.deviceRequirements.MotionSensor.OccupancySensingServer.with('PhysicalContact', 'OccupancyEvent'));
                else if (kind === 'leak') accessory.deviceType = types.LeakSensor;
                else if (kind === 'smoke' || kind === 'co') accessory.deviceType = types.SmokeSensor;
                else accessory.deviceType = types.ContactSensor;
                break;
            }
            case 'energy':
                accessory.deviceType = types.ElectricalSensor;
                break;
            case 'door':
                accessory.deviceType = types.DoorLock;
                accessory.handlers.doorLock = {
                    unlockDoor: () => run({ type: 'unlock' }),
                    lockDoor: () => { throw this.protocolError('InvalidAction', 'This momentary relay cannot actively lock the door'); },
                };
                if (entry.config.doorbell) {
                    accessory.parts = [{ id: 'doorbell', displayName: matterText(`${accessory.displayName} Sonnette`, 64), deviceType: types.GenericSwitch, clusters: {} }];
                }
                break;
            case 'scenario':
                accessory.deviceType = types.OnOffOutlet;
                accessory.handlers.onOff = {
                    on: () => run({ type: 'activate' }),
                    off: () => { this.assertUsable(record); this.queueState(record, entry.device.snapshot(), true); },
                    toggle: () => run({ type: 'activate' }),
                };
                break;
        }
    }

    private dimmerType(record: LiveDevice): MatterAccessory['deviceType'] {
        const type = this.matter!.deviceTypes.DimmableLight;
        const Base = type.behaviors.levelControl;
        const actions = {
            level: (value: number, withOnOff: boolean) => this.setLevel(record, value, withOnOff),
            move: (direction: number, rate: number | null, withOnOff: boolean) => {
                const selected = this.numberInRange(direction, 0, 1);
                // With no defaultMoveRate configured, null means an immediate
                // move to the end of the range in the standard Matter behavior.
                if (rate == null) return this.setLevel(record, selected === 0 ? 254 : 0, withOnOff);
                return this.startDimming(record, selected, rate, withOnOff);
            },
            step: (direction: number, amount: number, withOnOff: boolean) => {
                const sign = this.numberInRange(direction, 0, 1) === 0 ? 1 : -1;
                const delta = this.numberInRange(amount, 0, 254);
                return this.setLevel(record, clamp(level(record.entry.device.snapshot().brightness) + sign * delta, 0, 254), withOnOff);
            },
            stop: () => { this.assertUsable(record); this.stopDimming(record); },
        };
        // Public behavior logic hooks cover both ordinary and WithOnOff variants.
        // Homebridge's handler wrapper only forwards five of these eight commands.
        // State is published from the shared controller, so no second transition
        // engine can overwrite the actual hardware level.
        class MyHomeLevelControl extends Base {
            moveToLevelLogic(value: number, _transitionTime: number | null, withOnOff: boolean): Promise<void> | void {
                return actions.level(value, withOnOff);
            }
            moveLogic(direction: number, rate: number | null, withOnOff: boolean): Promise<void> | void {
                return actions.move(direction, rate, withOnOff);
            }
            stepLogic(direction: number, amount: number, _transitionTime: number | null, withOnOff: boolean): Promise<void> | void {
                return actions.step(direction, amount, withOnOff);
            }
            stopLogic(): void {
                actions.stop();
            }
            stopWithOnOff(): void {
                // A move may still be waiting for its first hardware tick while
                // OnOff is false; cancellation must also work during that gap.
                actions.stop();
            }
        }
        return type.with(MyHomeLevelControl);
    }

    private setLevel(record: LiveDevice, value: number | undefined, withOnOff: boolean): Promise<void> | void {
        this.stopDimming(record);
        const requested = this.numberInRange(value, 0, 254);
        this.assertUsable(record);
        if (!withOnOff && !record.entry.device.snapshot().on) {
            this.queueState(record, record.entry.device.snapshot(), true);
            return;
        }
        return this.command(record, { type: 'brightness', value: withOnOff && requested <= 1 ? 0 : Math.max(1, Math.round(requested * 100 / 254)) });
    }

    private setTemperature(record: LiveDevice, value: number | undefined, mode: 'heat' | 'cool'): Promise<void> {
        const attribute = mode === 'heat' ? 'occupiedHeatingSetpoint' : 'occupiedCoolingSetpoint';
        if (typeof value === 'number' && record.thermostatEcho?.[attribute] === value) return Promise.resolve();
        const configured = this.matterMode(record);
        const requested = this.numberInRange(value, 500, 3000);
        const state = record.entry.device.snapshot();
        // setpointRaiseLower also raises an attribute-change event inside Matter.
        // In both-mode it may update both attributes for the one hardware target.
        if ((state.mode === 'heat' || state.mode === 'cool') && requested === temperature(state.targetTemperature)) {
            this.assertUsable(record);
            this.queueState(record, state, true);
            return Promise.resolve();
        }
        if ((configured !== 'both' && configured !== mode) || state.mode !== mode) {
            // Homebridge may deliver attribute writes through an asynchronous
            // reactor. Restore the real value even if that caller already committed.
            this.queueState(record, state, true);
            throw this.protocolError('InvalidInState', 'Choose the matching manual mode before changing the temperature');
        }
        return this.command(record, { type: 'temperature', value: requested / 100 });
    }

    private project(record: LiveDevice, state: DeviceState): Projection {
        const clusters: ClusterStates = { bridgedDeviceBasicInformation: { reachable: state.online, nodeLabel: matterText(state.name || 'MyHome') } };
        const parts = new Map<string, ClusterStates>();
        const config = record.entry.config;
        switch (record.entry.kind) {
            case 'light':
                clusters.onOff = { onOff: !!state.on };
                if (config.dimmer) clusters.levelControl = { currentLevel: level(state.brightness), minLevel: 1, maxLevel: 254 };
                break;
            case 'blind': {
                const moving = state.moving === 'opening' ? 1 : state.moving === 'closing' ? 2 : 0;
                clusters.windowCovering = {
                    type: 0, endProductType: 0,
                    configStatus: { operational: true, liftPositionAware: true },
                    currentPositionLiftPercent100ths: state.positionConfidence === 'unknown' ? null : position(state.position),
                    targetPositionLiftPercent100ths: position(state.targetPosition),
                    operationalStatus: { global: moving, lift: moving, tilt: 0 },
                };
                if (config.calibrationSwitch || config.calibration === 'manual') parts.set('calibration', { onOff: { onOff: !!state.calibrating } });
                break;
            }
            case 'thermostat': {
                const mode = this.matterMode(record);
                if (state.mode === 'heat' || state.mode === 'cool') record.manualMode = state.mode;
                else if (state.mode === 'auto' && (state.activeMode === 'heat' || state.activeMode === 'cool')) record.manualMode = state.activeMode;
                if (mode !== 'both') record.manualMode = mode;
                const systemMode = state.mode === 'off' ? 0 : record.manualMode === 'cool' ? 3 : 4;
                clusters.thermostat = {
                    localTemperature: Math.round(clamp(finite(state.temperature, 0), -273.15, 327.67) * 100),
                    systemMode, controlSequenceOfOperation: mode === 'both' ? 4 : mode === 'cool' ? 0 : 2,
                    // RunningMode requires Matter AutoMode; the relay bitmap works without it.
                    thermostatRunningState: { heat: state.activeMode === 'heat', cool: state.activeMode === 'cool' },
                    ...(mode !== 'cool' ? { occupiedHeatingSetpoint: temperature(state.targetTemperature), absMinHeatSetpointLimit: 500, absMaxHeatSetpointLimit: 3000, minHeatSetpointLimit: 500, maxHeatSetpointLimit: 3000 } : {}),
                    ...(mode !== 'heat' ? { occupiedCoolingSetpoint: temperature(state.targetTemperature), absMinCoolSetpointLimit: 500, absMaxCoolSetpointLimit: 3000, minCoolSetpointLimit: 500, maxCoolSetpointLimit: 3000 } : {}),
                };
                parts.set('programme', { onOff: { onOff: state.mode === 'auto' } });
                break;
            }
            case 'contact':
                if (config.sensorType === 'motion' || config.sensorType === 'occupancy') clusters.occupancySensing = { occupancy: { occupied: !!state.triggered } };
                else if (config.sensorType === 'smoke') clusters.smokeCoAlarm = { smokeState: state.triggered ? 2 : 0, expressedState: state.triggered ? 1 : 0 };
                else if (config.sensorType === 'co') clusters.smokeCoAlarm = { coState: state.triggered ? 2 : 0, expressedState: state.triggered ? 2 : 0 };
                else clusters.booleanState = { stateValue: config.sensorType === 'leak' ? !!state.triggered : !state.triggered };
                break;
            case 'energy':
                clusters.electricalPowerMeasurement = { powerMode: 2, activePower: Math.round(Math.max(0, finite(state.watts, 0)) * 1000) };
                break;
            case 'door':
                clusters.doorLock = {
                    lockState: state.locked === false ? 2 : 1, lockType: 2, actuatorEnabled: true,
                    operatingMode: 0, supportedOperatingModes: { normal: true, alwaysSet: 0x7ff },
                };
                if (config.doorbell) parts.set('doorbell', { switch: { numberOfPositions: 2, currentPosition: 0 } });
                break;
            case 'scenario':
                clusters.onOff = { onOff: !!state.on };
                break;
        }
        return { clusters, parts };
    }

    private assertUsable(record: LiveDevice): void {
        if (this.stopped || !record.active || !record.ready) throw this.protocolError('InvalidInState', 'Accessory is not ready');
        if (!record.entry.device.snapshot().online) throw this.protocolError('Failure', 'MyHome gateway is offline');
    }

    private protocolError(code: 'InvalidAction' | 'InvalidInState' | 'Failure' | 'Busy' | 'Timeout' | 'ConstraintError', message: string): Error {
        // Homebridge exposes these Error subclasses through its runtime API; do
        // not import the ESM-only Matter implementation into this CommonJS plugin.
        return new this.matter!.status[code](message) as unknown as Error;
    }

    private async command(record: LiveDevice, command: DeviceCommand, options?: DeviceCommandOptions): Promise<void> {
        try {
            this.assertUsable(record);
            await record.entry.device.execute(command, options);
            // Run after the Matter command transaction, including synchronous device events.
            this.queueState(record, record.entry.device.snapshot(), true);
        } catch (err) {
            this.queueState(record, record.entry.device.snapshot(), true);
            const e = typeof err === 'object' && err !== null ? err as { hapStatus?: number; code?: number } : undefined;
            if (this.matter!.status.isMatterProtocolError(err)) throw err;
            const code = e?.hapStatus ?? e?.code;
            if (code === -70403) throw this.protocolError('Busy', 'MyHome command queue is full');
            if (code === -70412) throw this.protocolError('InvalidInState', 'Command is not allowed in the current MyHome mode');
            if (code === -70408) throw this.protocolError('Timeout', 'MyHome command timed out');
            throw this.protocolError('Failure', errorMessage(err));
        }
    }

    private numberInRange(value: unknown, min: number, max: number): number {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
            throw this.protocolError('ConstraintError', `Expected a number in ${min}..${max}`);
        }
        return value;
    }

    private startDimming(record: LiveDevice, direction: number, rate: number, withOnOff = false): void {
        this.assertUsable(record);
        this.stopDimming(record);
        const speed = this.numberInRange(rate, 1, 254) * (direction === 0 ? 1 : -1);
        if (!withOnOff && !record.entry.device.snapshot().on) {
            this.queueState(record, record.entry.device.snapshot(), true);
            return;
        }
        record.dimmerLevel = level(record.entry.device.snapshot().brightness);
        const generation = record.dimmerGeneration;
        const cancellation = new AbortController();
        record.dimmerAbort = cancellation;
        let busy = false;
        let mayTurnOn = withOnOff && !record.entry.device.snapshot().on;
        record.dimmerTimer = setInterval(async () => {
            if (busy || generation !== record.dimmerGeneration) return;
            if (!record.entry.device.snapshot().on && !mayTurnOn) {
                this.stopDimming(record);
                return;
            }
            mayTurnOn = false;
            busy = true;
            try {
                record.dimmerLevel = clamp((record.dimmerLevel ?? 1) + speed / 4, 1, 254);
                await this.command(record, { type: 'brightness', value: withOnOff && record.dimmerLevel === 1 ? 0 : Math.max(1, Math.round(record.dimmerLevel * 100 / 254)) }, { signal: cancellation.signal });
                if (generation === record.dimmerGeneration && (record.dimmerLevel === 1 || record.dimmerLevel === 254)) this.stopDimming(record);
            } catch (err) {
                if (generation === record.dimmerGeneration) {
                    this.stopDimming(record);
                    this.log.warn('[Matter] Dimming stopped: %s', errorMessage(err));
                }
            } finally {
                busy = false;
            }
        }, 250);
    }

    private stopDimming(record: LiveDevice): void {
        clearInterval(record.dimmerTimer);
        record.dimmerTimer = undefined;
        record.dimmerGeneration++;
        const cancellation = record.dimmerAbort;
        record.dimmerAbort = undefined;
        cancellation?.abort();
    }

    private onEvent(record: LiveDevice, event: DeviceEvent): void {
        if (this.stopped || !record.active) return;
        if (event.type === 'state') {
            // A bus or HomeKit OFF takes precedence over an ongoing Matter move.
            if (!event.state.online || event.state.on === false) this.stopDimming(record);
            this.queueState(record, event.state);
        } else if (event.type === 'command') {
            // Cancel as soon as an OFF is queued, before a delayed ACK permits
            // the next dimming tick to enqueue a brightness command behind it.
            if ((event.command.type === 'power' && !event.command.value)
                || (event.command.type === 'brightness' && event.command.value === 0)) this.stopDimming(record);
        } else if (event.type === 'doorbell' && record.entry.kind === 'door' && record.entry.config.doorbell) {
            record.chain = record.chain.then(async () => {
                if (this.stopped || !record.active || !record.ready) return;
                await this.matter!.switch.emit(record.entry.UUID, 'press', { partId: 'doorbell' });
                if (this.stopped || !record.active) return;
                await this.matter!.switch.emit(record.entry.UUID, 'release', { partId: 'doorbell' });
            }).catch(err => { this.log.warn('[Matter] Doorbell update failed: %s', errorMessage(err)); });
        }
    }

    private queueState(record: LiveDevice, state: DeviceState, force = false): void {
        if (this.stopped || !record.active) return;
        if (state.mode === 'heat' || state.mode === 'cool') record.manualMode = state.mode;
        // Matter applies its own result after handlers return. Reassert the real
        // value even when hardware rounded it to the value we previously sent.
        if (force) { record.lastSent.clear(); record.correctionRevision++; }
        record.pending = state;
        if (!record.ready || record.timer) return;
        record.timer = setTimeout(() => {
            record.timer = undefined;
            const pending = record.pending;
            record.pending = undefined;
            if (!pending) return;
            record.chain = record.chain.then(() => this.flush(record, pending))
                .catch(err => { this.log.warn('[Matter] State update failed for %s: %s', record.entry.UUID, errorMessage(err)); });
        }, 0);
    }

    private async flush(record: LiveDevice, state: DeviceState): Promise<void> {
        if (this.stopped || !record.active || !record.ready) return;
        const projected = this.project(record, state);
        const update = async (cluster: string, attributes: Record<string, unknown>, partId?: string) => {
            if (this.stopped || !record.active) return;
            const key = `${partId ?? ''}:${cluster}`;
            const value = JSON.stringify(attributes);
            if (record.lastSent.get(key) === value) return;
            const revision = record.correctionRevision;
            if (cluster === 'thermostat' && !partId) record.thermostatEcho = attributes;
            try {
                await this.matter!.updateAccessoryState(record.entry.UUID, cluster, attributes, partId);
            } finally {
                if (cluster === 'thermostat' && !partId) record.thermostatEcho = undefined;
            }
            if (record.correctionRevision === revision) record.lastSent.set(key, value);
        };
        for (const [cluster, attributes] of Object.entries(projected.clusters)) await update(cluster, attributes);
        for (const [part, clusters] of projected.parts) {
            for (const [cluster, attributes] of Object.entries(clusters)) await update(cluster, attributes, part);
        }
        if (this.stopped || !record.active) return;
        const context = { kind: record.entry.kind, deviceContext: { ...record.entry.context }, manualMode: record.manualMode, matterSignature: record.signature };
        const contextJSON = JSON.stringify(context);
        const displayName = matterText(state.name || 'MyHome');
        if (contextJSON !== record.contextJSON || record.accessory.displayName !== displayName) {
            record.accessory.context = context;
            record.accessory.displayName = displayName;
            for (const part of record.accessory.parts ?? []) {
                if (part.id === 'programme') part.displayName = matterText(`${displayName} Programme automatique`, 64);
                else if (part.id === 'doorbell') part.displayName = matterText(`${displayName} Sonnette`, 64);
                else if (part.id === 'calibration') part.displayName = matterText(`${displayName} Calibration`, 64);
            }
            await this.matter!.updatePlatformAccessories([record.accessory]);
            record.contextJSON = contextJSON;
        }
    }

    private dispose(record: LiveDevice): void {
        record.active = false;
        record.unsubscribe?.();
        record.unsubscribe = undefined;
        clearTimeout(record.timer);
        this.stopDimming(record);
        record.pending = undefined;
    }

    destroy(): void {
        this.stopped = true;
        for (const record of this.live.values()) this.dispose(record);
        this.live.clear();
        this.retainedContexts.clear();
    }
}
