import type { Characteristic, CharacteristicValue, HapStatusError, Logging, Perms, PlatformAccessory, Service } from 'homebridge';
import type { OwnClient } from './OwnNet';
import { PKT } from './OwnNet';
import { OwnProtcol, WHO } from './OwnProtcol';
import { PLUGIN_VERSION } from './constants';
import type { DeviceCommand, DeviceCommandOptions, DeviceEvent, DeviceMode, DeviceState, OwnDevice } from './OwnDevice';
import { OwnBlindController, BlindError, type BlindConfig, type BlindState } from './OwnBlindController';
export type { BlindConfig } from './OwnBlindController';
import {
    brightnessToOwnLevel,
    ownLevelToBrightness,
    errorMessage,
    IDENTIFY_BLINK_MS,
    SCENARIO_RESET_MS,
    DOOR_RESET_MS,
    COMMAND_QUEUE_BUSY_THRESHOLD,
    ENERGY_POLL_INTERVAL_MS,
    ENERGY_POLL_QUEUE_THRESHOLD,
    ENERGY_OUTLET_IN_USE_THRESHOLD_W,
    ENERGY_MIN_LIGHT_LEVEL,
} from './utils';

export interface OwnPlatformLike {
    log: Logging;
    controller: OwnClient;
    Service: typeof Service;
    Characteristic: typeof Characteristic;
    HapStatusError: new (status: number) => HapStatusError;
    HAPStatus: Record<string, number>;
    /** Optional: notify Homebridge that an accessory was mutated (e.g., displayName change). */
    updateAccessory?(accessory: PlatformAccessory): void;
    persistAccessory?(accessory: PlatformAccessory, immediate: boolean): void;
}

export interface BaseConfig {
    id: number;
    name?: string;
}

export interface LightConfig extends BaseConfig {
    dimmer?: boolean;
    /** Custom OpenWebNet WHERE address (e.g. "68#4#01" for group/special relays). Defaults to id. */
    where?: string;
}

export interface ThermostatConfig extends BaseConfig {
    zone: number;
    /** Raw central/zone address; e.g. #1 for a 99-zone unit. Default: #0#<zone>. */
    where?: string;
    /** Capabilities advertised by the Matter adapter; HomeKit keeps its existing modes. */
    matterMode?: 'heat' | 'cool' | 'both';
}

export interface ScenarioConfig extends BaseConfig {
    /** Scenario module address (01..99, optionally on a local bus). */
    where?: string;
    /** Scenario number 1..20; defaults to id. */
    scenario?: number;
    // Note: the historical `asButton` option was removed because a HomeKit
    // StatelessProgrammableSwitch is emit-only — it cannot receive taps from
    // the Home app, so `asButton: true` silently disabled scenario activation.
    // Scenarios are always exposed as an auto-reset Switch now.
}
export interface ContactConfig extends BaseConfig {
    sensorType?: 'contact' | 'motion' | 'occupancy' | 'leak' | 'smoke' | 'co';
    protocol?: 'auxiliary' | 'dry-contact' | 'ir';
    where?: string;
}
export interface EnergyConfig extends BaseConfig {
    asOutlet?: boolean;
    where?: string;
}
export interface DoorConfig extends BaseConfig {
    openCommand?: string;
    doorbell?: boolean;
}

class OwnAccessory implements OwnDevice {
    protected log: Logging;
    protected controller: OwnClient;
    protected Service: typeof Service;
    protected Characteristic: typeof Characteristic;
    protected HapStatusError: new (status: number) => HapStatusError;
    protected HAPStatus: Record<string, number>;
    protected platform: OwnPlatformLike;
    accessory: PlatformAccessory;
    name: string;
    protected id: number;
    protected fault = false;
    destroyed = false;
    private readonly deviceListeners = new Set<(event: DeviceEvent) => void>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private charWarningListener: ((warning: any) => void) | undefined;

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: BaseConfig, defaultType?: string) {
        this.log = platform.log;
        this.controller = platform.controller;
        this.Service = platform.Service;
        this.Characteristic = platform.Characteristic;
        this.HapStatusError = platform.HapStatusError;
        this.HAPStatus = platform.HAPStatus;
        this.platform = platform;
        this.accessory = accessory;

        // Derive a display name if the user didn't provide one. `defaultType` is the
        // short kind label ('light', 'blind', 'thermostat', ...) supplied by each subclass;
        // the resulting default is `<type>-<id>`. We fall back to just the id when no
        // defaultType is provided (older callers). Use a null/undefined check (not a falsy
        // one) so an explicit empty-string name is left as-is rather than overwritten.
        if (config.name == null) {
            config.name = defaultType ? `${defaultType}-${config.id}` : String(config.id);
        }

        this.name = config.name ?? '';
        this.id = config.id;

        if (!Number.isInteger(this.id) || this.id <= 0) {
            throw new Error(`homebridge-myhome: invalid accessory id "${config.id}" — must be a positive integer`);
        }

        // Restore configuredName from a previous session (HomeKit rename) if present;
        // the user-supplied config name remains the default.
        const persisted = (accessory.context as Record<string, unknown>).configuredName;
        if (typeof persisted === 'string' && persisted.length > 0) {
            this.name = persisted;
        }

        this.accessory.getService(this.Service.AccessoryInformation)!
            .setCharacteristic(this.Characteristic.Manufacturer, 'Legrand / BTicino')
            .setCharacteristic(this.Characteristic.Model, 'Accessory')
            .setCharacteristic(this.Characteristic.SerialNumber, `MyHome-${this.id}`)
            .setCharacteristic(this.Characteristic.FirmwareRevision, PLUGIN_VERSION);

        this.accessory.on('identify', () => { this.log.info(`[${this.id}] Identify`); });

        // Surface HAP-NodeJS characteristic warnings (e.g. validValues clamping, missing perms)
        // so they appear in the Homebridge log instead of being silently swallowed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const accAny = this.accessory as any;
        if (typeof accAny.on === 'function') {
            try {
                this.charWarningListener = (warning: { type: string; message: string; characteristic?: { displayName?: string } }) => {
                    const charName = warning.characteristic?.displayName ?? '?';
                    this.log.warn('[%s] HAP warn (%s) on %s: %s', this.id, warning.type, charName, warning.message);
                };
                accAny.on('characteristic-warning', this.charWarningListener);
            } catch {
                // older HAP versions don't emit this event — silently ignore
            }
        }
    }

    /** Updates the gateway hardware revision on this accessory's AccessoryInformation service. */
    setHardwareRevision(label: string): void {
        this.accessory.getService(this.Service.AccessoryInformation)
            ?.setCharacteristic(this.Characteristic.HardwareRevision, label);
    }

    protected initPrimaryService(
        serviceType: typeof Service,
        modelName: string,
        withFault = false,
        withStatusActive = false,
    ): InstanceType<typeof Service> {
        this.accessory.getService(this.Service.AccessoryInformation)!
            .setCharacteristic(this.Characteristic.Model, modelName);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const svc = this.accessory.getService(serviceType as any) ?? this.accessory.addService(serviceType as any);
        svc.setPrimaryService(true);
        svc.setCharacteristic(this.Characteristic.Name, this.name);
        svc.setCharacteristic(this.Characteristic.ConfiguredName, this.name);
        // Persist user rename from the Home app across Homebridge restarts.
        svc.getCharacteristic(this.Characteristic.ConfiguredName)
            .onSet((value: CharacteristicValue) => {
                const newName = String(value);
                if (newName === this.name) return;
                this.name = newName;
                (this.accessory.context as Record<string, unknown>).configuredName = newName;
                // Keep Homebridge UI in sync — displayName is what shows in the bridge logs/UI
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (this.accessory as any).displayName = newName;
                // Push the displayName change to Homebridge's accessory cache so it survives a restart.
                this.platform.updateAccessory?.(this.accessory);
                this.log.info(`[${this.id}] Renamed to "${newName}"`);
                this.publishState();
            });
        if (withStatusActive) {
            svc.getCharacteristic(this.Characteristic.StatusActive)
                .onGet(() => !this.fault);
        }
        if (withFault) {
            svc.getCharacteristic(this.Characteristic.StatusFault)
                .onGet(() => this.fault
                    ? this.Characteristic.StatusFault.GENERAL_FAULT
                    : this.Characteristic.StatusFault.NO_FAULT);
        }
        return svc;
    }

    protected setFaultOnline(svc: InstanceType<typeof Service>, online: boolean, withStatusActive = false): void {
        this.fault = !online;
        if (withStatusActive) svc.updateCharacteristic(this.Characteristic.StatusActive, online);
        svc.updateCharacteristic(
            this.Characteristic.StatusFault,
            online ? this.Characteristic.StatusFault.NO_FAULT : this.Characteristic.StatusFault.GENERAL_FAULT,
        );
        this.publishState();
    }

    snapshot(): DeviceState {
        return { name: this.name, online: !this.fault && !this.destroyed };
    }

    subscribe(listener: (event: DeviceEvent) => void): () => void {
        if (this.destroyed) return () => {};
        this.deviceListeners.add(listener);
        return () => { this.deviceListeners.delete(listener); };
    }

    protected publish(event: DeviceEvent): void {
        if (this.destroyed) return;
        for (const listener of this.deviceListeners) {
            try { listener(event); } catch (err) {
                this.log.warn('[%s] Device subscriber failed: %s', this.id, errorMessage(err));
            }
        }
    }

    protected publishState(): void {
        this.publish({ type: 'state', state: this.snapshot() });
    }

    execute(command: DeviceCommand, options?: DeviceCommandOptions): void | Promise<void> {
        if (this.destroyed) throw new this.HapStatusError(this.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        if (options?.signal?.aborted) throw new this.HapStatusError(this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        if (command.type === 'identify') {
            this.accessory.emit('identify');
        } else {
            const result = this.executeDeviceCommand(command, options);
            this.publish({ type: 'command', command });
            // Asynchronous commands publish their committed state on ACK.
            if (result) return result;
        }
        this.publishState();
    }

    protected executeDeviceCommand(_command: DeviceCommand, _options?: DeviceCommandOptions): void | Promise<void> {
        throw new this.HapStatusError(this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }

    protected get commandKey(): string {
        return `${this.who}:${this.id}`;
    }

    /** Complete a user action only after the gateway acknowledges it. */
    protected sendOrThrow(command: string, onAck: () => void = () => {}, onStarted?: () => void, options?: DeviceCommandOptions): Promise<void> {
        if (this.controller.queueSize() >= COMMAND_QUEUE_BUSY_THRESHOLD) {
            this.log.warn('[%s] Command dropped (queue full): %s', this.id, command);
            throw new this.HapStatusError(this.HAPStatus.RESOURCE_BUSY);
        }
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const result = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
        let settled = false;
        const queued = this.controller.sendCommand({
            command, log: this.log, serialKey: this.commandKey, started: onStarted, signal: options?.signal,
            done: (packet, _index, failure) => {
                if (settled) return;
                settled = true;
                if (this.destroyed || packet !== PKT.ACK) {
                    if (failure === 'cancelled') this.log.debug('[%s] Command cancelled: %s', this.id, command);
                    else this.log.warn('[%s] Command failed (%s): %s', this.id, failure ?? 'gateway rejected or disconnected', command);
                    reject(new this.HapStatusError(failure === 'timeout'
                        ? this.HAPStatus.OPERATION_TIMED_OUT : failure === 'cancelled'
                            ? this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE : this.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
                    return;
                }
                try {
                    onAck();
                    this.publishState();
                    resolve();
                } catch (err) { reject(err); }
            },
        });
        if (!queued) {
            this.log.warn('[%s] Command rejected (queue saturated): %s', this.id, command);
            throw new this.HapStatusError(this.HAPStatus.RESOURCE_BUSY);
        }
        return result;
    }

    updateStatus(): void {
        this.log.info(`[${this.id}] Accessory updateStatus`);
    }

    onData(packet: string): void {
        this.log.debug('OwnAccessory.OnData', packet);
    }

    checkWhere(where: string): boolean {
        return where === String(this.id);
    }

    /**
     * OWN WHO code this accessory subscribes to. Subclasses override.
     * Used by OwnPlatform.onAccessory to disambiguate routing when two accessories
     * of different types share the same numeric id (e.g. lights[id=42] and doors[id=42]).
     */
    get who(): number | null {
        return null;
    }

    setOnline(online: boolean): void {
        this.fault = !online;
        this.publishState();
    }

    destroy(): void {
        this.destroyed = true;
        this.deviceListeners.clear();
        // Best-effort listener cleanup — accessory is unregistered shortly after destroy(),
        // but explicit removal documents intent and prevents leaks if the object survives.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const accAny = this.accessory as any;
        if (this.charWarningListener && typeof accAny.off === 'function') {
            try { accAny.off('characteristic-warning', this.charWarningListener); } catch { /* ignore */ }
        }
        this.charWarningListener = undefined;
        this.accessory.removeAllListeners('identify');
    }
}

export class OwnLightAccessory extends OwnAccessory {
    value: boolean;
    dimmer: boolean;
    brightness: number;
    /** OWN WHERE address — may differ from id for special relay configurations (e.g. "68#4#01"). */
    readonly where: string;
    private lightbulbService: InstanceType<typeof Service>;
    private identifyTimeout: ReturnType<typeof setTimeout> | undefined;
    private powerRevision = 0;
    private brightnessRevision = 0;
    private hapCorrection?: ReturnType<typeof setTimeout>;

    get who(): number { return WHO.light; }

    checkWhere(where: string): boolean {
        return where === this.where;
    }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: LightConfig) {
        super(platform, accessory, config, 'light');

        this.value = false;
        this.dimmer = config.dimmer ?? false;
        this.brightness = 100;
        this.where = config.where ?? String(this.id);
        if (!OwnProtcol.isWhere(this.where)) throw new Error('Light where must be an OpenWebNet address');
        this.identifyTimeout = undefined;

        this.accessory.removeAllListeners('identify');
        this.accessory.on('identify', () => {
            this.log.info(`[${this.id}] Identify — blink`);
            const wasOn = this.value;
            this.controller.sendCommand({ command: `*1*0*${this.where}##`, log: this.log });
            clearTimeout(this.identifyTimeout);
            this.identifyTimeout = setTimeout(() => {
                this.identifyTimeout = undefined;
                if (wasOn) this.controller.sendCommand({ command: `*1*1*${this.where}##`, log: this.log });
            }, IDENTIFY_BLINK_MS);
        });

        this.lightbulbService = this.initPrimaryService(this.Service.Lightbulb, 'Light', true);

        this.lightbulbService.getCharacteristic(this.Characteristic.On)
            .onGet(() => this.value)
            .onSet((value: CharacteristicValue) => this.setFromHap({ type: 'power', value: value as boolean }));

        if (this.dimmer) {
            this.lightbulbService.getCharacteristic(this.Characteristic.Brightness)
                .onGet(() => this.brightness)
                .onSet((value: CharacteristicValue) => this.setFromHap({ type: 'brightness', value: value as number }));
        }
    }

    snapshot(): DeviceState {
        return { ...super.snapshot(), on: this.value, brightness: this.brightness };
    }

    private setFromHap(command: DeviceCommand): void | Promise<void> {
        const result = this.execute(command);
        return Promise.resolve(result).then(() => {
            if (this.destroyed) return;
            // HAP commits the requested value after onSet returns. Reassert the
            // actual bus value/quantized level outside that write transaction.
            clearTimeout(this.hapCorrection);
            this.hapCorrection = setTimeout(() => {
                this.hapCorrection = undefined;
                if (this.destroyed) return;
                this.lightbulbService.updateCharacteristic(this.Characteristic.On, this.value);
                if (this.dimmer) this.lightbulbService.updateCharacteristic(this.Characteristic.Brightness, this.brightness);
            }, 0);
        });
    }

    protected executeDeviceCommand(command: DeviceCommand, options?: DeviceCommandOptions): void | Promise<void> {
        let powerRevision = this.powerRevision;
        let brightnessRevision = this.brightnessRevision;
        const started = () => { powerRevision = this.powerRevision; brightnessRevision = this.brightnessRevision; };
        if (command.type === 'power') {
            this.log.info(`[${this.id}] Setting power state to ${command.value ? 'on' : 'off'}`);
            const level = command.value && this.dimmer ? brightnessToOwnLevel(this.brightness) : command.value ? 1 : 0;
            return this.sendOrThrow(`*1*${level}*${this.where}##`, () => {
                if (powerRevision === this.powerRevision) this.value = command.value;
                if (this.dimmer && command.value && this.value && brightnessRevision === this.brightnessRevision) {
                    this.brightness = ownLevelToBrightness(level);
                    this.lightbulbService.updateCharacteristic(this.Characteristic.Brightness, this.brightness);
                }
                this.lightbulbService.updateCharacteristic(this.Characteristic.On, this.value);
            }, started, options);
        } else if (command.type === 'brightness' && this.dimmer) {
            const value = command.value;
            if (!Number.isFinite(value) || value < 0 || value > 100) {
                throw new this.HapStatusError(this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
            }
            this.log.info(`[${this.id}] Setting brightness to ${value}`);
            const level = value === 0 ? 0 : brightnessToOwnLevel(value);
            return this.sendOrThrow(`*1*${level}*${this.where}##`, () => {
                const on = value !== 0;
                if (powerRevision === this.powerRevision) this.value = on;
                // A generic ON report conveys no brightness. Fill in that missing
                // value, while preserving newer level reports or a contrary OFF.
                if (brightnessRevision === this.brightnessRevision && this.value === on) {
                    this.brightness = level === 0 ? 0 : ownLevelToBrightness(level);
                }
                this.lightbulbService.updateCharacteristic(this.Characteristic.Brightness, this.brightness);
                this.lightbulbService.updateCharacteristic(this.Characteristic.On, this.value);
            }, started, options);
        } else {
            return super.executeDeviceCommand(command);
        }
    }

    setOnline(online: boolean): void {
        this.setFaultOnline(this.lightbulbService, online);
    }

    updateStatus(): void {
        this.log.info(`[${this.id}] Light updateStatus`);
        this.controller.sendCommand({
            command: `*#1*${this.where}##`,
            log: this.log,
            packet: (pkt: string) => {
                this.onData(pkt);
            },
        });
    }

    onData(packet: string): void {
        const state = OwnProtcol.decodeLightState(packet);
        if (state && state.where === this.where) {
            this.powerRevision++;
            this.log.debug('id:%s onLight(%s)', this.id, packet);
            this.value = state.on;
            if (this.dimmer && state.brightness !== undefined) {
                this.brightnessRevision++;
                this.brightness = state.brightness;
                this.lightbulbService.updateCharacteristic(this.Characteristic.Brightness, this.brightness);
            }
            this.lightbulbService.updateCharacteristic(this.Characteristic.On, this.value);
            this.publishState();
        } else {
            this.log.debug('[%s] Light ignoring packet:%s', this.id, packet);
        }
    }

    destroy(): void {
        clearTimeout(this.identifyTimeout);
        clearTimeout(this.hapCorrection);
        super.destroy();
    }
}

export class OwnBlindAccessory extends OwnAccessory {
    readonly blind: OwnBlindController;
    private readonly windowCoveringService: Service;
    private readonly calibrationService?: Service;

    get who(): number { return WHO.automation; }
    checkWhere(where: string): boolean { return where === this.blind.where; }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: BlindConfig) {
        super(platform, accessory, config, 'blind');
        this.windowCoveringService = this.initPrimaryService(this.Service.WindowCovering, 'WindowCovering', true);
        this.blind = new OwnBlindController(this.controller, this.log, config, accessory.context, (state, persist) => {
            this.render(state);
            if (persist) {
                const cached = this.blind.serialize();
                const previous = accessory.context.blindState;
                accessory.context.blindState = Object.assign(typeof previous === 'object' && previous !== null && !Array.isArray(previous) ? previous : {}, cached);
                accessory.context.blindPosition = Math.round(cached.position);
                if (platform.persistAccessory) platform.persistAccessory(accessory, persist === 'now');
                else platform.updateAccessory?.(accessory);
            }
            this.publishState();
        });
        const service = this.windowCoveringService;
        service.getCharacteristic(this.Characteristic.CurrentPosition).onGet(() => this.snapshot().position!);
        service.getCharacteristic(this.Characteristic.TargetPosition)
            .onGet(() => this.snapshot().targetPosition!)
            .onSet(value => this.execute({ type: 'position', value: Number(value) }));
        service.getCharacteristic(this.Characteristic.PositionState).onGet(() => this.hapMovement(this.blind.snapshot()));
        service.getCharacteristic(this.Characteristic.StatusFault).onGet(() => this.hapFault(this.blind.snapshot()));
        service.getCharacteristic(this.Characteristic.ObstructionDetected).onGet(() => false);
        service.getCharacteristic(this.Characteristic.HoldPosition).onSet(() => this.execute({ type: 'stop' }));
        if (config.calibrationSwitch || config.calibration === 'manual') {
            this.calibrationService = accessory.getService(this.Service.Switch)
                ?? accessory.addService(this.Service.Switch, `${this.name} Calibration`, 'calibration');
            service.addLinkedService(this.calibrationService);
            this.calibrationService.getCharacteristic(this.Characteristic.On)
                .onGet(() => this.blind.snapshot().calibrating)
                .onSet(value => value ? this.execute({ type: 'calibrate' })
                    : this.blind.snapshot().calibrating ? this.execute({ type: 'stop' }) : undefined);
        } else {
            const old = accessory.getService(this.Service.Switch);
            if (old) { service.removeLinkedService(old); accessory.removeService(old); }
        }
        accessory.removeAllListeners('identify');
        accessory.on('identify', () => {
            void this.blind.identify().catch(err => this.log.warn('[%s] Identify failed: %s', this.id, errorMessage(err)));
        });
        this.render(this.blind.snapshot());
    }

    private hapMovement(state: BlindState): number {
        const values = this.Characteristic.PositionState;
        return state.moving === 'opening' ? values.INCREASING : state.moving === 'closing' ? values.DECREASING : values.STOPPED;
    }

    private render(state: BlindState): void {
        this.windowCoveringService.updateCharacteristic(this.Characteristic.CurrentPosition, Math.round(state.position));
        this.windowCoveringService.updateCharacteristic(this.Characteristic.TargetPosition, Math.round(state.targetPosition));
        this.windowCoveringService.updateCharacteristic(this.Characteristic.PositionState, this.hapMovement(state));
        this.windowCoveringService.updateCharacteristic(this.Characteristic.StatusFault, this.hapFault(state));
        this.calibrationService?.updateCharacteristic(this.Characteristic.On, state.calibrating);
    }

    private hapFault(state: BlindState): number {
        return !state.online || state.positionConfidence === 'unknown' || state.blindPhase === 'fault'
            ? this.Characteristic.StatusFault.GENERAL_FAULT : this.Characteristic.StatusFault.NO_FAULT;
    }

    snapshot(): DeviceState {
        const state = this.blind.snapshot();
        return { ...super.snapshot(), ...state, position: Math.round(state.position), targetPosition: Math.round(state.targetPosition) };
    }

    protected executeDeviceCommand(command: DeviceCommand): void | Promise<void> {
        const result = command.type === 'position' ? this.blind.moveTo(command.value)
            : command.type === 'stop' ? this.blind.stop()
                : command.type === 'calibrate' ? this.blind.calibrate() : undefined;
        if (!result) return super.executeDeviceCommand(command);
        return result.catch(err => {
            const code = err instanceof BlindError ? err.code : 'communication';
            throw new this.HapStatusError(code === 'busy' ? this.HAPStatus.RESOURCE_BUSY
                : code === 'timeout' ? this.HAPStatus.OPERATION_TIMED_OUT
                    : code === 'invalid' || code === 'cancelled' ? this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE
                        : this.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        });
    }

    setOnline(online: boolean): void { this.blind.setOnline(online); super.setOnline(online); this.render(this.blind.snapshot()); }
    updateStatus(): void { this.blind.updateStatus(); }

    onData(packet: string): void { this.blind.onData(packet); }
    destroy(): void { this.blind.destroy(); super.destroy(); }
}

interface ThermostatWrite {
    mode: DeviceMode;
    temperature?: number;
    signal: AbortSignal;
    sequence: number;
    modeRevision: number;
    temperatureRevision: number;
    echoed: boolean;
    expires: number;
}

export class OwnThermostatAccessory extends OwnAccessory {
    zone: number;
    address: string;
    temperature: number;
    targetTemperature: number;
    heatingCoolingState: number;
    targetHeatingCoolingState: number;
    private targetModeKnown = false;
    private pendingMode?: { value: DeviceMode };
    private modeRevision = 0;
    private temperatureRevision = 0;
    private writeSequence = 0;
    private controlRevision = 0;
    private intent = new AbortController();
    private writes: ThermostatWrite[] = [];
    private hapCorrection?: ReturnType<typeof setTimeout>;
    displayUnits: number;
    private thermostatService: InstanceType<typeof Service>;
    private temperatureSensorService: InstanceType<typeof Service>;

    get who(): number { return WHO.temperature; }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ThermostatConfig) {
        super(platform, accessory, config, 'thermostat');

        if (!Number.isInteger(config.zone) || config.zone <= 0) {
            throw new Error(`homebridge-myhome: thermostat id=${config.id} requires a positive integer "zone"`);
        }
        this.zone = config.zone;
        this.address = config.where ?? `#0#${this.zone}`;
        if (!/^#\d+(?:#\d+)?$/.test(this.address)) throw new Error('Thermostat where must be a central or zone address beginning with #');

        this.temperature = 0;
        // Default to 20°C (within the 5..30 range exposed to HomeKit) so the initial
        // characteristic read does not produce a "value exceeded minimum" HAP warning.
        // Real value will be overwritten by the first DIM 14 packet from the gateway.
        this.targetTemperature = 20;
        this.heatingCoolingState = this.Characteristic.CurrentHeatingCoolingState.OFF;
        this.targetHeatingCoolingState = this.Characteristic.TargetHeatingCoolingState.OFF;
        this.displayUnits = this.Characteristic.TemperatureDisplayUnits.CELSIUS;

        this.thermostatService = this.initPrimaryService(this.Service.Thermostat, 'Thermostat', true);

        // Linked TemperatureSensor — exposes CurrentTemperature for the Home app's
        // temperature history graph (Thermostat.CurrentTemperature is not graphed).
        this.temperatureSensorService = this.accessory.getService(this.Service.TemperatureSensor)
            ?? this.accessory.addService(this.Service.TemperatureSensor, `${this.name} Temperature`, 'temperature');
        this.temperatureSensorService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: -50, maxValue: 50, minStep: 0.1 })
            .onGet(() => this.temperature);
        // HAP-NodeJS deduplicates linked services by iid — calling on every restart is safe.
        this.thermostatService.addLinkedService(this.temperatureSensorService);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.heatingCoolingState);

        const TargetState = this.Characteristic.TargetHeatingCoolingState;
        this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [TargetState.OFF, TargetState.HEAT, TargetState.COOL, TargetState.AUTO] })
            .onGet(() => this.targetHeatingCoolingState)
            .onSet((value: CharacteristicValue) => {
                const mode = this.modeFromHap(value as number);
                return this.setFromHap({ type: 'mode', value: mode });
            });

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: -50, maxValue: 50, minStep: 0.1 })
            .onGet(() => this.temperature);

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: 5, minStep: 0.5, maxValue: 30 })
            .onGet(() => this.targetTemperature)
            .onSet((value: CharacteristicValue) => this.setFromHap({ type: 'temperature', value: value as number }));

        this.thermostatService.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .onGet(() => this.displayUnits)
            .onSet((value: CharacteristicValue) => { this.displayUnits = value as number; });
    }

    private modeFromHap(value: number): DeviceMode {
        const target = this.Characteristic.TargetHeatingCoolingState;
        if (value === target.HEAT) return 'heat';
        if (value === target.COOL) return 'cool';
        if (value === target.AUTO) return 'auto';
        return 'off';
    }

    snapshot(): DeviceState {
        return {
            ...super.snapshot(), temperature: this.temperature, targetTemperature: this.targetTemperature,
            mode: this.modeFromHap(this.targetHeatingCoolingState),
            activeMode: this.heatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.HEAT ? 'heat'
                : this.heatingCoolingState === this.Characteristic.CurrentHeatingCoolingState.COOL ? 'cool' : 'off',
        };
    }

    private setFromHap(command: DeviceCommand): Promise<void> {
        const result = this.execute(command);
        return Promise.resolve(result).then(() => {
            if (this.destroyed) return;
            clearTimeout(this.hapCorrection);
            this.hapCorrection = setTimeout(() => {
                this.hapCorrection = undefined;
                if (this.destroyed) return;
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.targetHeatingCoolingState);
                this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.targetTemperature);
            }, 0);
        });
    }

    private sendThermostat(packet: string, mode: DeviceMode, temperature?: number): Promise<void> {
        this.controlRevision++;
        const write: ThermostatWrite = { mode, temperature, signal: this.intent.signal, sequence: 0,
            modeRevision: this.modeRevision, temperatureRevision: this.temperatureRevision, echoed: false, expires: Infinity };
        this.writes = this.writes.filter(w => w.expires >= Date.now());
        this.writes.push(write);
        let result: Promise<void>;
        try {
            result = this.sendOrThrow(packet, () => {
                if (write.signal.aborted) return;
                const target = this.Characteristic.TargetHeatingCoolingState;
                if (write.modeRevision === this.modeRevision) {
                    this.updateCharacteristicTargetHeatingCoolingState(mode === 'heat' ? target.HEAT
                        : mode === 'cool' ? target.COOL : mode === 'auto' ? target.AUTO : target.OFF);
                }
                if (temperature !== undefined && write.temperatureRevision === this.temperatureRevision) {
                    this.updateCharacteristicTargetTemperature(temperature);
                }
            }, () => {
                write.sequence = ++this.writeSequence;
                write.modeRevision = this.modeRevision;
                write.temperatureRevision = this.temperatureRevision;
            }, { signal: write.signal });
        } catch (err) {
            write.expires = 0;
            throw err;
        }
        return result.then(() => { write.expires = Date.now() + 1000; }, err => {
            write.expires = 0;
            throw err;
        });
    }

    private observeMode(mode: DeviceMode, temperature?: number): void {
        this.writes = this.writes.filter(w => w.expires >= Date.now());
        const echo = this.writes.find(w => w.sequence > 0 && !w.echoed && w.mode === mode
            && (temperature === undefined || temperature === w.temperature));
        if (echo) {
            echo.echoed = true;
            if (echo.sequence < this.writeSequence || echo.signal.aborted) return;
        } else {
            // A central-unit mode/setpoint change supersedes queued remote writes.
            // Keep matching own echoes from cancelling a newer queued user choice.
            this.intent.abort();
            this.intent = new AbortController();
            this.pendingMode = undefined;
        }
        this.modeRevision++;
        const target = this.Characteristic.TargetHeatingCoolingState;
        this.updateCharacteristicTargetHeatingCoolingState(mode === 'heat' ? target.HEAT
            : mode === 'cool' ? target.COOL : mode === 'auto' ? target.AUTO : target.OFF);
        if (temperature !== undefined) {
            this.temperatureRevision++;
            this.updateCharacteristicTargetTemperature(temperature);
        }
    }

    protected executeDeviceCommand(command: DeviceCommand): void | Promise<void> {
        if (command.type === 'mode') {
            const mode = command.value;
            let packet: string;
            let setpoint: number | undefined;
            if (mode === 'heat' || mode === 'cool') {
                const temperature = OwnProtcol.encodeTemperature(this.targetTemperature);
                setpoint = OwnProtcol.decodeTemperature(temperature);
                packet = `*#4*${this.address}*#14*${temperature}*${mode === 'heat' ? 1 : 2}##`;
            } else if (mode === 'off') {
                packet = `*4*303*${this.address}##`;
            } else {
                // MyHome programme mode is deliberately distinct from Matter heat/cool Auto.
                packet = `*4*${/^#[1-9]\d*$/.test(this.address) ? 311 : 3100}*${this.address}##`;
            }
            // HomeKit may write mode and temperature together. Keep the desired
            // mode for subsequent queued writes without reporting it as confirmed.
            const pending = { value: mode };
            const previous = this.pendingMode;
            this.pendingMode = pending;
            try {
                return this.sendThermostat(packet, mode, setpoint).finally(() => {
                    if (this.pendingMode === pending) this.pendingMode = undefined;
                });
            } catch (err) {
                this.pendingMode = previous;
                throw err;
            }
        } else if (command.type === 'temperature') {
            if (!Number.isFinite(command.value) || command.value < 5 || command.value > 30) {
                throw new this.HapStatusError(this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
            }
            const mode = this.pendingMode?.value ?? this.modeFromHap(this.targetHeatingCoolingState);
            if (mode !== 'heat' && mode !== 'cool') {
                this.log.error("Can't change target temperature with mode (%s)", this.targetHeatingCoolingState);
                throw new this.HapStatusError(this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
            }
            const temperature = OwnProtcol.encodeTemperature(command.value);
            return this.sendThermostat(`*#4*${this.address}*#14*${temperature}*${mode === 'cool' ? 2 : 1}##`,
                mode, OwnProtcol.decodeTemperature(temperature));
        } else {
            return super.executeDeviceCommand(command);
        }
    }

    setOnline(online: boolean): void {
        this.setFaultOnline(this.thermostatService, online);
    }

    updateStatus(): void {
        this.log.info(`[${this.id}] Thermostat updateStatus`);
        if (this.writes.some(write => write.expires === Infinity)) return;
        const controlRevision = this.controlRevision;
        let modeRevision = this.modeRevision;
        let temperatureRevision = this.temperatureRevision;
        const handler = (pkt: string) => {
            if (controlRevision !== this.controlRevision || modeRevision !== this.modeRevision || temperatureRevision !== this.temperatureRevision) return;
            this.onData(pkt);
            modeRevision = this.modeRevision;
            temperatureRevision = this.temperatureRevision;
        };
        this.controller.sendCommand({ command: `*#4*${this.address}##`, log: this.log, packet: handler });
        this.controller.sendCommand({ command: `*#4*${this.id}##`, log: this.log, packet: handler });
    }

    checkWhere(where: string): boolean {
        return this.address === where || super.checkWhere(where);
    }

    updateCharacteristicCurrentTemperature(temperature: number): void {
        this.log.info(`[${this.id}] update CurrentTemperature (${temperature})`);
        this.temperature = temperature;
        this.thermostatService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.temperature);
        this.temperatureSensorService.updateCharacteristic(this.Characteristic.CurrentTemperature, this.temperature);
        this.publishState();
    }

    updateCharacteristicTargetTemperature(temperature: number): void {
        this.log.info(`[${this.id}] update TargetTemperature (${temperature})`);
        // Clamp to the HAP-exposed range [5, 30] to avoid characteristic warnings
        // when the gateway reports a setpoint outside the displayable range
        // (e.g. 0 when the zone is OFF).
        this.targetTemperature = Math.min(30, Math.max(5, temperature));
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.targetTemperature);
        this.publishState();
    }

    updateCharacteristicTargetHeatingCoolingState(state: number): void {
        this.log.info(`[${this.id}] update TargetHeatingCoolingState (${state})`);
        this.targetHeatingCoolingState = state;
        this.targetModeKnown = true;
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.targetHeatingCoolingState);
        this.publishState();
    }

    updateCharacteristicCurrentHeatingCoolingState(state: number): void {
        this.log.info(`[${this.id}] update CurrentHeatingCoolingState (${state})`);
        this.heatingCoolingState = state;
        this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.heatingCoolingState);
        this.publishState();
    }

    onData(packet: string): void {
        let extract: RegExpMatchArray | null;
        if ((extract = packet.match(/^\*#4\*\d+\*0\*([01]\d{3})(?:\*[123])?##$/))) {
            this.updateCharacteristicCurrentTemperature(OwnProtcol.decodeTemperature(extract[1]));
        } else if ((extract = packet.match(/^\*#4\*\d+\*12\*(\d+)\*3##$/))) {
            this.log.debug(`[${this.id}] zone[${this.zone}] probe temperature with local offset (${OwnProtcol.decodeTemperature(extract[1])})`);
        } else if ((extract = packet.match(/^\*#4\*\d+\*13\*(\d+)##$/))) {
            const value = extract[1];
            const offsets: Record<string, { offset: number; status: string }> = {
                '00': { offset: 0, status: 'Local ON' },
                '01': { offset: 1, status: 'Local ON' },
                '11': { offset: -1, status: 'Local ON' },
                '02': { offset: 2, status: 'Local ON' },
                '12': { offset: -2, status: 'Local ON' },
                '03': { offset: 3, status: 'Local ON' },
                '13': { offset: -3, status: 'Local ON' },
                '04': { offset: 0, status: 'Local OFF' },
                '05': { offset: 0, status: 'Local protection' },
            };
            const decoded = offsets[value];
            if (!decoded) {
                this.log.warn('[%s] zone[%s] unknown DIM 13 value (%s) in packet: %s', this.id, this.zone, value, packet);
            } else {
                this.log.debug('[%s] zone[%s] local offset:%s (%s)', this.id, this.zone, decoded.offset, decoded.status);
            }
        } else if ((extract = packet.match(/^\*#4\*[\d#]+\*14\*(\d+)\*(\d+)##$/))) {
            // DIM 14 = Setpoint temperature. Second value is the mode byte:
            //   *1 = Heat, *2 = Cool, *3 = Generic (mode not enforced).
            this.temperatureRevision++;
            this.updateCharacteristicTargetTemperature(OwnProtcol.decodeTemperature(extract[1]));
            // A setpoint report is not an authoritative mode change. Use its mode
            // only to seed an unknown startup state, never to leave AUTO or an
            // explicitly selected OFF/HEAT/COOL mode.
            const modeByte = extract[2];
            const TargetState = this.Characteristic.TargetHeatingCoolingState;
            if (!this.targetModeKnown && !this.pendingMode && this.targetHeatingCoolingState === TargetState.OFF) {
                if (modeByte === '1') {
                    this.updateCharacteristicTargetHeatingCoolingState(TargetState.HEAT);
                } else if (modeByte === '2') {
                    this.updateCharacteristicTargetHeatingCoolingState(TargetState.COOL);
                }
                // modeByte === '3' (Generic) leaves the current target state untouched.
            }
        } else if ((extract = packet.match(/^\*#4\*[\d#]+\*19\*(\d)\*(\d)##$/))) {
            const CV = extract[1];
            const HV = extract[2];
            const coolingActive = ['1', '2', '6', '7', '8'].includes(CV);
            const heatingActive = ['1', '2', '6', '7', '8'].includes(HV);
            if (heatingActive) {
                this.log.debug(`[${this.id}] zone[${this.zone}] heating ON`);
                this.updateCharacteristicCurrentHeatingCoolingState(this.Characteristic.CurrentHeatingCoolingState.HEAT);
            } else if (coolingActive) {
                this.log.debug(`[${this.id}] zone[${this.zone}] cooling ON`);
                this.updateCharacteristicCurrentHeatingCoolingState(this.Characteristic.CurrentHeatingCoolingState.COOL);
            } else {
                this.log.debug(`[${this.id}] zone[${this.zone}] heating/cooling OFF`);
                this.updateCharacteristicCurrentHeatingCoolingState(this.Characteristic.CurrentHeatingCoolingState.OFF);
            }
        } else if ((extract = packet.match(/^\*#4\*\d+#\d+\*20\*(\d+)##$/))) {
            const value = extract[1];
            const status = value === '0' ? 'OFF'
                : value === '1' ? 'ON'
                : value === '4' ? 'STOP'
                : `not decoded:${value}`;
            this.log.debug(`[${this.id}] zone[${this.zone}] actuator status (${status})`);
        } else if ((extract = packet.match(/^\*4\*(\d+)\*\d+##$/))) {
            const value = extract[1];
            let status: string;
            if (value === '0') status = 'Conditioning';
            else if (value === '1') status = 'Heating';
            else if (value === '102') status = 'Antifreeze';
            else if (value === '202') status = 'Thermal Protection';
            else if (value === '303') status = 'Generic OFF';
            else if (value === '3100') status = 'AUTO Weekly Program';
            else {
                status = `not decoded:${value}`;
                this.log.error('[%s] zone[%s] operation mode (%s)', this.id, this.zone, value);
            }
            this.log.debug(`[${this.id}] zone[${this.zone}] operation mode (${status})`);
            // WHO 4 §1.9.2 reports operating mode, not valve activity. DIM 19
            // supplies CurrentHeatingCoolingState, including fan-coil speeds.
        } else if ((extract = packet.match(/^\*4\*(\d+)\*#\d+(?:#\d+)?##$/))) {
            const valInt = parseInt(extract[1], 10);
            if ([103, 203, 303].includes(valInt)) {
                this.observeMode('off');
                this.log.debug('[%s] zone[%s] operation mode Heating OFF', this.id, this.zone);
            } else if ([102, 202, 302].includes(valInt)) {
                this.observeMode('off');
                this.log.debug('[%s] zone[%s] operation mode Anti Freeze', this.id, this.zone);
            } else if ([111, 211, 311, 1101, 1102, 1103, 2101, 2102, 2103, 3101, 3102, 3103].includes(valInt)) {
                this.observeMode('auto');
                this.log.debug('[%s] zone[%s] operation mode Heating program', this.id, this.zone);
            } else if ((valInt > 13000 && valInt <= 13255) || (valInt > 23000 && valInt <= 23255)) {
                this.observeMode('auto');
                this.log.debug('[%s] zone[%s] operation mode Holiday program for %s day', this.id, this.zone, valInt - 13000);
            } else if (valInt === 21) {
                this.log.debug('[%s] zone[%s] Remote control enabled', this.id, this.zone);
            } else if (valInt === 0 || valInt === 210) {
                this.observeMode('cool');
                this.log.debug('[%s] zone[%s] operation mode Conditioning', this.id, this.zone);
            } else if (valInt === 110) {
                this.observeMode('heat');
            } else {
                this.log.error('[%s] zone[%s] unknown value (%i) in packet: %s', this.id, this.zone, valInt, packet);
            }
        } else if ((extract = packet.match(/^\*4\*(\d+)#([01]\d{3})\*#\d+(?:#\d+)?##$/))) {
            const value = extract[1];
            if (value === '110') {
                const temp = OwnProtcol.decodeTemperature(extract[2]);
                this.log.debug('[%s] zone[%s] operation mode Manual Heating (%s)', this.id, this.zone, temp);
                this.observeMode('heat', temp);
            } else if (value === '210') {
                const temp = OwnProtcol.decodeTemperature(extract[2]);
                this.log.debug('[%s] zone[%s] operation mode Manual Cooling (%s)', this.id, this.zone, temp);
                this.observeMode('cool', temp);
            }
        } else {
            this.log.error('[%s] zone[%s] unknown packet: %s', this.id, this.zone, packet);
        }
    }

    destroy(): void {
        this.intent.abort();
        clearTimeout(this.hapCorrection);
        super.destroy();
    }
}

export class OwnScenarioAccessory extends OwnAccessory {
    private resetTimeout: ReturnType<typeof setTimeout> | undefined;
    private service: InstanceType<typeof Service>;
    private active = false;
    private readonly where?: string;
    private readonly scenario: number;

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ScenarioConfig) {
        super(platform, accessory, config, 'scenario');

        this.where = config.where;
        this.scenario = config.scenario ?? config.id;
        if (!Number.isInteger(this.scenario) || this.scenario < 1 || this.scenario > 20) throw new Error('Scenario number must be in 1..20');
        if (this.where !== undefined && (!/^\d{1,2}(?:#4#\d{1,2})?$/.test(this.where) || Number(this.where.split('#')[0]) < 1)) {
            throw new Error('Scenario where must identify a module in 01..99');
        }

        this.resetTimeout = undefined;

        // Switch with auto-reset — preserves compatibility with existing HomeKit automations
        // and, unlike StatelessProgrammableSwitch, actually receives taps from the Home app.
        this.service = this.initPrimaryService(this.Service.Switch, 'Scenario');
        this.service.getCharacteristic(this.Characteristic.On)
            .onGet(() => false)
            .onSet((value: CharacteristicValue) => {
                if (value) return this.execute({ type: 'activate' });
            });
        // Remove a previously-registered StatelessProgrammableSwitch from installs
        // that used the deprecated `asButton: true` option.
        const existingSPS = this.accessory.getService(this.Service.StatelessProgrammableSwitch);
        if (existingSPS) this.accessory.removeService(existingSPS);
    }

    snapshot(): DeviceState {
        return { ...super.snapshot(), on: this.active };
    }

    protected executeDeviceCommand(command: DeviceCommand): void | Promise<void> {
        if (command.type !== 'activate') return super.executeDeviceCommand(command);
        if (!this.where) {
            this.log.error('[%s] Configure scenario "where" with its module address (01..99); WHO 0 has no general address 0.', this.id);
            throw new this.HapStatusError(this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
        }
        this.log.info(`[${this.id}] Scenario activate`);
        return this.sendOrThrow(`*0*${this.scenario}*${this.where}##`, () => {
            this.active = true;
            this.service.updateCharacteristic(this.Characteristic.On, true);
            clearTimeout(this.resetTimeout);
            this.resetTimeout = setTimeout(() => {
                this.active = false;
                this.service.updateCharacteristic(this.Characteristic.On, false);
                this.publishState();
            }, SCENARIO_RESET_MS);
        });
    }

    onData(_packet: string): void {}
    checkWhere(_where: string): boolean { return false; }
    destroy(): void {
        clearTimeout(this.resetTimeout);
        super.destroy();
    }
}

type SensorTypeKey = 'contact' | 'motion' | 'occupancy' | 'leak' | 'smoke' | 'co';

export class OwnContactAccessory extends OwnAccessory {
    contactState: number;
    private sensorType: SensorTypeKey;
    private sensorService: InstanceType<typeof Service>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stateChar: any;
    private readonly protocol: NonNullable<ContactConfig['protocol']>;
    private readonly where: string;

    get who(): number { return this.protocol === 'auxiliary' ? WHO.auxiliary : WHO.CEN; }
    checkWhere(where: string): boolean { return where === this.where; }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ContactConfig) {
        super(platform, accessory, config, 'contact');

        this.sensorType = config.sensorType ?? 'contact';
        this.protocol = config.protocol ?? 'auxiliary';
        if (!['auxiliary', 'dry-contact', 'ir'].includes(this.protocol)) throw new Error('Invalid contact protocol');
        this.where = config.where ?? (this.protocol === 'auxiliary' ? String(this.id) : `3${this.id}`);
        if (!OwnProtcol.isWhere(this.where)) throw new Error('Contact where must be an OpenWebNet address');
        this.contactState = this.Characteristic.ContactSensorState.CONTACT_DETECTED;

        // Single mapping table: sensor type → (HAP service, model name, state characteristic).
        // Adding a new sensor type is a one-line entry here.
        const SENSOR_MAP: Record<SensorTypeKey, { svc: typeof Service; model: string; char: unknown }> = {
            contact:   { svc: this.Service.ContactSensor,         model: 'ContactSensor',         char: this.Characteristic.ContactSensorState },
            motion:    { svc: this.Service.MotionSensor,          model: 'MotionSensor',          char: this.Characteristic.MotionDetected },
            occupancy: { svc: this.Service.OccupancySensor,       model: 'OccupancySensor',       char: this.Characteristic.OccupancyDetected },
            leak:      { svc: this.Service.LeakSensor,            model: 'LeakSensor',            char: this.Characteristic.LeakDetected },
            smoke:     { svc: this.Service.SmokeSensor,           model: 'SmokeSensor',           char: this.Characteristic.SmokeDetected },
            co:        { svc: this.Service.CarbonMonoxideSensor,  model: 'CarbonMonoxideSensor',  char: this.Characteristic.CarbonMonoxideDetected },
        };
        const cfg = SENSOR_MAP[this.sensorType];

        // Remove stale sensor services if sensorType changed across restarts
        for (const t of Object.keys(SENSOR_MAP) as SensorTypeKey[]) {
            if (t !== this.sensorType) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const stale = this.accessory.getService(SENSOR_MAP[t].svc as any);
                if (stale) this.accessory.removeService(stale);
            }
        }

        this.sensorService = this.initPrimaryService(cfg.svc, cfg.model, true, true);
        this.stateChar = cfg.char;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.sensorService.getCharacteristic(cfg.char as any)
            .onGet(() => this.mapStateForSensor(this.contactState));
    }

    snapshot(): DeviceState {
        return { ...super.snapshot(), triggered: this.contactState !== this.Characteristic.ContactSensorState.CONTACT_DETECTED };
    }

    private mapStateForSensor(rawState: number): boolean | number {
        if (this.sensorType === 'contact') {
            return rawState; // 0=DETECTED, 1=NOT_DETECTED
        }
        // For motion/occupancy: contact CLOSED (0) → no motion/no occupancy; OPEN (1) → motion/occupancy
        // For leak/smoke/co: contact CLOSED (0) → safe (NOT_DETECTED=0); OPEN (1) → alarm (DETECTED=1)
        const triggered = rawState !== this.Characteristic.ContactSensorState.CONTACT_DETECTED;
        if (this.sensorType === 'motion' || this.sensorType === 'occupancy') return triggered;
        return triggered ? 1 : 0;
    }

    setOnline(online: boolean): void {
        this.setFaultOnline(this.sensorService, online, true);
    }

    updateStatus(): void {
        this.log.info(`[${this.id}] ${this.sensorType} updateStatus`);
        this.controller.sendCommand({
            command: `*#${this.who}*${this.where}##`,
            log: this.log,
            packet: (pkt: string) => { this.onData(pkt); },
        });
    }

    onData(packet: string): void {
        const extract = this.protocol === 'auxiliary'
            ? packet.match(/^\*9\*([01])\*([\d#]+)##$/)
            : packet.match(/^\*25\*(31|32)#[01]\*([\d#]+)##$/);
        if (extract && extract[2] === this.where) {
            const closed = this.protocol === 'auxiliary' ? extract[1] === '0'
                : this.protocol === 'ir' ? extract[1] === '32' : extract[1] === '31';
            this.contactState = closed
                ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
                : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
            this.log.info(`[${this.id}] ${this.sensorType} state: ${this.contactState}`);
            this.sensorService.updateCharacteristic(this.stateChar, this.mapStateForSensor(this.contactState));
            this.publishState();
        } else {
            this.log.error('[%s] Contact unknown packet:%s', this.id, packet);
        }
    }
}

// Eve Consumption custom characteristic UUID (watts) — supported by Eve.app for energy graphing.
const EVE_CONSUMPTION_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

export class OwnEnergyAccessory extends OwnAccessory {
    watts: number;
    private asOutlet: boolean;
    private energyService: InstanceType<typeof Service>;
    private pollInterval: ReturnType<typeof setInterval>;
    private eveWattsChar: Characteristic | undefined;
    private readonly where: string;

    get who(): number { return WHO.energy; }
    checkWhere(where: string): boolean { return where === this.where; }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: EnergyConfig) {
        super(platform, accessory, config, 'energy');

        this.watts = 0;
        this.where = config.where ?? String(this.id);
        if (!OwnProtcol.isWhere(this.where)) throw new Error('Energy where must be an OpenWebNet address');
        this.asOutlet = config.asOutlet ?? false;

        if (this.asOutlet) {
            this.energyService = this.initPrimaryService(this.Service.Outlet, 'EnergyMonitor', true, true);
            this.energyService.getCharacteristic(this.Characteristic.On)
                .onGet(() => this.watts > ENERGY_OUTLET_IN_USE_THRESHOLD_W)
                .onSet(() => { /* read-only meter — ignore writes */ });
            this.energyService.getCharacteristic(this.Characteristic.OutletInUse)
                .onGet(() => this.watts > ENERGY_OUTLET_IN_USE_THRESHOLD_W);
            // Eve custom characteristic for watts
            try {
                this.eveWattsChar = this.energyService.characteristics.find(c => c.UUID === EVE_CONSUMPTION_UUID);
                if (!this.eveWattsChar) {
                    this.eveWattsChar = this.energyService.addCharacteristic(new this.Characteristic(
                        'Eve Consumption', EVE_CONSUMPTION_UUID, {
                            format: 'float',
                            perms: ['ev', 'pr'] as Perms[],
                            unit: 'W',
                            minValue: 0, maxValue: 100000, minStep: 0.1,
                        },
                    ));
                }
            } catch (err) {
                this.log.debug('[%s] Eve consumption characteristic unavailable: %s', this.id, errorMessage(err));
            }
            // Remove a previously-registered LightSensor service if config flipped
            const existing = this.accessory.getService(this.Service.LightSensor);
            if (existing) this.accessory.removeService(existing);
        } else {
            // Legacy mode: lux-hack on LightSensor (preserves existing automations)
            this.energyService = this.initPrimaryService(this.Service.LightSensor, 'EnergyMonitor', true, true);
            this.energyService.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
                .onGet(() => Math.max(ENERGY_MIN_LIGHT_LEVEL, this.watts));
            // Remove a previously-registered Outlet service (asOutlet flipped true→false)
            const existingOutlet = this.accessory.getService(this.Service.Outlet);
            if (existingOutlet) this.accessory.removeService(existingOutlet);
        }

        this.pollInterval = setInterval(() => {
            if (!this.destroyed && this.controller.queueSize() < ENERGY_POLL_QUEUE_THRESHOLD) this.updateStatus();
        }, ENERGY_POLL_INTERVAL_MS);
    }

    snapshot(): DeviceState {
        return { ...super.snapshot(), watts: this.watts };
    }

    setOnline(online: boolean): void {
        this.setFaultOnline(this.energyService, online, true);
    }

    destroy(): void {
        this.destroyed = true;
        clearInterval(this.pollInterval);
        this.eveWattsChar = undefined;
        super.destroy();
    }

    updateStatus(): void {
        if (this.destroyed) return;
        this.log.debug(`[${this.id}] Energy updateStatus`);
        this.controller.sendCommand({
            command: `*#18*${this.where}*113##`,
            log: this.log,
            packet: (pkt: string) => { this.onData(pkt); },
        });
    }

    onData(packet: string): void {
        if (this.destroyed) return;
        const extract = packet.match(/^\*#18\*([\d#]+)\*113\*(\d+)##$/);
        if (extract && extract[1] === this.where) {
            this.watts = parseInt(extract[2], 10);
            this.log.debug(`[${this.id}] Energy: ${this.watts}W`);
            if (this.asOutlet) {
                const inUse = this.watts > ENERGY_OUTLET_IN_USE_THRESHOLD_W;
                this.energyService.updateCharacteristic(this.Characteristic.On, inUse);
                this.energyService.updateCharacteristic(this.Characteristic.OutletInUse, inUse);
                this.eveWattsChar?.updateValue(this.watts);
            } else {
                this.energyService.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, Math.max(ENERGY_MIN_LIGHT_LEVEL, this.watts));
            }
            this.publishState();
        } else {
            this.log.debug('[%s] Energy: ignoring packet %s', this.id, packet);
        }
    }
}

export class OwnDoorAccessory extends OwnAccessory {
    private openCommand: string;
    private openEventCode: string | null;
    private doorbellEnabled: boolean;
    private lockService: InstanceType<typeof Service>;
    private doorbellService: InstanceType<typeof Service> | null;
    private resetTimeout: ReturnType<typeof setTimeout> | undefined;
    private currentLockState: number;

    get who(): number { return WHO.videoDoor; }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: DoorConfig) {
        super(platform, accessory, config, 'door');

        this.openCommand = config.openCommand ?? `*7*19*${this.id}##`;
        this.doorbellEnabled = config.doorbell ?? false;
        this.resetTimeout = undefined;
        this.doorbellService = null;
        this.currentLockState = this.Characteristic.LockCurrentState.SECURED;

        // Extract the WHO=7 event code we send when releasing the door, so we can
        // filter the gateway echo from triggering a spurious doorbell ring.
        const m = this.openCommand.match(/^\*7\*(\d+)\*/);
        this.openEventCode = m ? m[1] : null;

        this.lockService = this.initPrimaryService(this.Service.LockMechanism, 'Door', true);

        this.lockService.getCharacteristic(this.Characteristic.LockCurrentState)
            .onGet(() => this.currentLockState);

        this.lockService.getCharacteristic(this.Characteristic.LockTargetState)
            .onGet(() => this.currentLockState === this.Characteristic.LockCurrentState.UNSECURED
                ? this.Characteristic.LockTargetState.UNSECURED
                : this.Characteristic.LockTargetState.SECURED)
            .onSet((value: CharacteristicValue) => {
                if (value === this.Characteristic.LockTargetState.UNSECURED) return this.execute({ type: 'unlock' });
            });

        if (this.doorbellEnabled) {
            this.doorbellService = this.accessory.getService(this.Service.Doorbell)
                ?? this.accessory.addService(this.Service.Doorbell, `${this.name} Doorbell`, 'doorbell');
            this.doorbellService.getCharacteristic(this.Characteristic.ProgrammableSwitchEvent)
                .setProps({ validValues: [this.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS] });
            // HAP-NodeJS deduplicates linked services by iid.
            this.lockService.addLinkedService(this.doorbellService);
        } else {
            // Remove a previously-registered Doorbell service if the config flipped.
            // removeLinkedService first, then removeService — keeps the HAP descriptor consistent.
            const existing = this.accessory.getService(this.Service.Doorbell);
            if (existing) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const lockAny = this.lockService as any;
                if (typeof lockAny.removeLinkedService === 'function') {
                    try { lockAny.removeLinkedService(existing); } catch { /* HAP version mismatch */ }
                }
                this.accessory.removeService(existing);
            }
        }
    }

    snapshot(): DeviceState {
        return { ...super.snapshot(), locked: this.currentLockState !== this.Characteristic.LockCurrentState.UNSECURED };
    }

    protected executeDeviceCommand(command: DeviceCommand): void | Promise<void> {
        if (command.type !== 'unlock') return super.executeDeviceCommand(command);
        this.log.info(`[${this.id}] Door open`);
        return this.sendOrThrow(this.openCommand, () => {
            this.currentLockState = this.Characteristic.LockCurrentState.UNSECURED;
            this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.currentLockState);
            this.lockService.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.UNSECURED);
            clearTimeout(this.resetTimeout);
            this.resetTimeout = setTimeout(() => {
                this.resetTimeout = undefined;
                this.currentLockState = this.Characteristic.LockCurrentState.SECURED;
                this.lockService.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.SECURED);
                this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.currentLockState);
                this.publishState();
            }, DOOR_RESET_MS);
        });
    }

    setOnline(online: boolean): void {
        this.setFaultOnline(this.lockService, online);
    }

    /** Doorbell-typed accessories also accept WHO=7 broadcasts (where=0). */
    checkWhere(where: string): boolean {
        // Match own id (lock ops always come back for this address) plus
        // broadcast where=0 packets (intercom incoming-call broadcasts).
        const idNum = parseInt(where, 10);
        if (idNum === this.id) return true;
        return this.doorbellEnabled && idNum === 0;
    }

    onData(packet: string): void {
        if (!this.doorbellEnabled || !this.doorbellService) return;
        // Accept *7*<event>*<addr>## where addr is digits, including '0' broadcast.
        // Skip our own open command's event echo to avoid firing the doorbell on user-initiated opens.
        const m = packet.match(/^\*7\*(\d+)\*(\d+)##$/);
        if (!m) return;
        const event = m[1];
        const where = m[2];
        if (event === this.openEventCode) {
            this.log.debug('[%s] Doorbell ignoring open echo (event=%s)', this.id, event);
            return;
        }
        const whereNum = parseInt(where, 10);
        const targetsThisDoor = whereNum === this.id || whereNum === 0;
        if (!targetsThisDoor) return;
        this.log.info(`[${this.id}] Doorbell ring (event=${event} where=${where})`);
        this.doorbellService.updateCharacteristic(
            this.Characteristic.ProgrammableSwitchEvent,
            this.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
        );
        this.publish({ type: 'doorbell' });
    }

    destroy(): void {
        clearTimeout(this.resetTimeout);
        super.destroy();
    }
}
