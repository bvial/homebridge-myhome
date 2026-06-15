import type { Characteristic, CharacteristicValue, HapStatusError, Logging, PlatformAccessory, Service } from 'homebridge';
import type { OwnClient } from './OwnNet';
import { OwnProtcol, WHO } from './OwnProtcol';
import { PLUGIN_VERSION } from './constants';
import {
    brightnessToOwnLevel,
    ownLevelToBrightness,
    errorMessage,
    IDENTIFY_BLINK_MS,
    IDENTIFY_JOG_MS,
    SCENARIO_RESET_MS,
    DOOR_RESET_MS,
    BLIND_MOVE_RETRY_INTERVAL_MS,
    BLIND_MAX_MOVE_RETRIES,
    BLIND_COMMAND_ECHO_TIMEOUT_MS,
    BLIND_INIT_CALIBRATION_MARGIN_MS,
    BLIND_QUEUE_BUSY_THRESHOLD,
    BLIND_MIN_TICK_MS,
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

export interface BlindConfig extends BaseConfig {
    time: number;
    timeSlat?: number;
    slatPercent?: number;
    /** Re-calibrate (move fully down) on first Homebridge start to establish a known position.
     *  Set to false to restore the last cached position without moving the blind (default: true). */
    calibrateOnStart?: boolean;
}

export interface ThermostatConfig extends BaseConfig {
    zone: number;
}

export interface ScenarioConfig extends BaseConfig {
    asButton?: boolean;
}
export interface ContactConfig extends BaseConfig {
    sensorType?: 'contact' | 'motion' | 'occupancy' | 'leak' | 'smoke' | 'co';
}
export interface EnergyConfig extends BaseConfig {
    asOutlet?: boolean;
}
export interface DoorConfig extends BaseConfig {
    openCommand?: string;
    doorbell?: boolean;
}

class OwnAccessory {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private charWarningListener: ((warning: any) => void) | undefined;

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: BaseConfig) {
        this.log = platform.log;
        this.controller = platform.controller;
        this.Service = platform.Service;
        this.Characteristic = platform.Characteristic;
        this.HapStatusError = platform.HapStatusError;
        this.HAPStatus = platform.HAPStatus;
        this.platform = platform;
        this.accessory = accessory;

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
    }

    protected sendOrThrow(command: string): void {
        if (this.controller.queueSize() >= BLIND_QUEUE_BUSY_THRESHOLD) {
            this.log.warn('[%s] Command dropped (queue full): %s', this.id, command);
            throw new this.HapStatusError(this.HAPStatus.RESOURCE_BUSY);
        }
        if (!this.controller.sendCommand({ command, log: this.log })) {
            this.log.warn('[%s] Command rejected (queue saturated): %s', this.id, command);
            throw new this.HapStatusError(this.HAPStatus.RESOURCE_BUSY);
        }
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

    setOnline(_online: boolean): void {}

    destroy(): void {
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

    get who(): number { return WHO.light; }

    checkWhere(where: string): boolean {
        return where === this.where;
    }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: LightConfig) {
        if (!config.name) config.name = `light-${config.id}`;
        super(platform, accessory, config);

        this.value = false;
        this.dimmer = config.dimmer ?? false;
        this.brightness = 100;
        this.where = config.where ?? String(this.id);
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
            .onSet((value: CharacteristicValue) => {
                this.log.info(`[${this.id}] Setting power state to ${value ? 'on' : 'off'}`);
                if (value && this.dimmer) {
                    const level = brightnessToOwnLevel(this.brightness);
                    this.sendOrThrow(`*1*${level}*${this.where}##`);
                } else {
                    this.sendOrThrow(`*1*${value ? '1' : '0'}*${this.where}##`);
                }
                this.value = value as boolean;
            });

        if (this.dimmer) {
            this.lightbulbService.getCharacteristic(this.Characteristic.Brightness)
                .onGet(() => this.brightness)
                .onSet((value: CharacteristicValue) => {
                    this.log.info(`[${this.id}] Setting brightness to ${value}`);
                    if (value === 0) {
                        this.sendOrThrow(`*1*0*${this.where}##`);
                        this.brightness = 0;
                        this.value = false;
                        this.lightbulbService.updateCharacteristic(this.Characteristic.On, false);
                    } else {
                        const level = brightnessToOwnLevel(value as number);
                        this.sendOrThrow(`*1*${level}*${this.where}##`);
                        this.brightness = value as number;
                    }
                });
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
                const m = pkt.match(/^\*#1\*[\d#]+\*1\*(\d+)##$/);
                if (m) this.onData(`*1*${m[1]}*${this.where}##`);
            },
        });
    }

    onData(packet: string): void {
        // Extended scenario/automation format *1*1000#<level>*<id>## — treat sub-level as the effective level
        const ext = packet.match(/^\*1\*1000#(\d+)\*[\d#]+##$/);
        const extract = ext ?? packet.match(/^\*1\*(\d+)\*[\d#]+##$/);
        if (extract) {
            this.log.debug('id:%s onLight(%s)', this.id, packet);
            const level = parseInt(extract[1], 10);
            if (level === 0) {
                this.log.info(`[${this.id}] power off`);
                this.value = false;
            } else {
                this.log.info(`[${this.id}] power on (level ${level})`);
                this.value = true;
                if (this.dimmer && level >= 2) {
                    this.brightness = ownLevelToBrightness(level);
                    this.lightbulbService.updateCharacteristic(this.Characteristic.Brightness, this.brightness);
                }
            }
            this.lightbulbService.updateCharacteristic(this.Characteristic.On, this.value);
        } else {
            this.log.error('[%s] Light unknown packet:%s', this.id, packet);
        }
    }

    destroy(): void {
        clearTimeout(this.identifyTimeout);
        super.destroy();
    }
}

export class OwnBlindAccessory extends OwnAccessory {
    time: number;
    timeSlat: number;
    slatPercent: number;
    state: number;
    expectedState: number;
    position: number;
    initStartPosition: boolean;
    commandSent: boolean;
    target: number;
    moveTrackingTimeout: ReturnType<typeof setTimeout> | undefined;
    packetTimeout: ReturnType<typeof setTimeout> | undefined;
    positionTimeout: ReturnType<typeof setTimeout> | undefined;
    moveRetries: number;
    initPhase: boolean;
    homeKitMovement: boolean;
    private calibrateOnStart: boolean;
    private inStatusQuery: boolean;
    private statusQueryTimeout: ReturnType<typeof setTimeout> | undefined;
    private initTimeout: ReturnType<typeof setTimeout> | undefined;
    private identifyJogTimeout: ReturnType<typeof setTimeout> | undefined;
    private windowCoveringService: InstanceType<typeof Service>;

    get who(): number { return WHO.automation; }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: BlindConfig) {
        if (!config.name) config.name = `blind-${config.id}`;
        super(platform, accessory, config);

        if (!config.time || config.time <= 0) {
            throw new Error(`homebridge-myhome: blind id=${config.id} requires a positive "time" value`);
        }
        this.time = config.time;
        this.timeSlat = config.timeSlat ?? 0;
        this.slatPercent = config.slatPercent ?? 0;
        this.calibrateOnStart = config.calibrateOnStart ?? true;

        this.state = this.Characteristic.PositionState.STOPPED;
        this.expectedState = this.Characteristic.PositionState.STOPPED;
        this.position = this.readCachedPosition();
        this.target = this.position;
        this.initStartPosition = false;
        this.commandSent = false;
        this.moveTrackingTimeout = undefined;
        this.packetTimeout = undefined;
        this.positionTimeout = undefined;
        this.moveRetries = 0;
        this.initPhase = false;
        this.homeKitMovement = false;
        this.inStatusQuery = false;
        this.statusQueryTimeout = undefined;
        this.initTimeout = undefined;

        this.windowCoveringService = this.initPrimaryService(this.Service.WindowCovering, 'WindowCovering', true);

        this.windowCoveringService.getCharacteristic(this.Characteristic.CurrentPosition)
            .onGet(() => this.position);

        this.windowCoveringService.getCharacteristic(this.Characteristic.TargetPosition)
            .onGet(() => this.target)
            .onSet((target: CharacteristicValue) => {
                if (this.controller.queueSize() >= BLIND_QUEUE_BUSY_THRESHOLD) {
                    throw new this.HapStatusError(this.HAPStatus.RESOURCE_BUSY);
                }
                this.log.info(`[${this.id}] Blind setting Target :${target}`);
                this.stopMoveTracking();
                this.target = target as number;
                this.move();
            });

        this.windowCoveringService.getCharacteristic(this.Characteristic.PositionState)
            .onGet(() => this.state);

        this.windowCoveringService.getCharacteristic(this.Characteristic.ObstructionDetected)
            .onGet(() => false);

        this.windowCoveringService.getCharacteristic(this.Characteristic.HoldPosition)
            .onSet((hold: CharacteristicValue) => {
                if (this.controller.queueSize() >= BLIND_QUEUE_BUSY_THRESHOLD) {
                    throw new this.HapStatusError(this.HAPStatus.RESOURCE_BUSY);
                }
                this.log.info(`[${this.id}] Blind hold position :${hold}`);
                this.stopMoveTracking();
                this.target = this.position;
                this.move();
            });

        this.accessory.removeAllListeners('identify');
        this.accessory.on('identify', () => {
            this.log.info(`[${this.id}] Identify — jog`);
            this.stopMoveTracking();  // cancel any in-progress HomeKit movement cleanly
            this.moveUp();
            clearTimeout(this.identifyJogTimeout);
            this.identifyJogTimeout = setTimeout(() => {
                this.identifyJogTimeout = undefined;
                this.stopMoveTracking();  // clear position tracking before issuing STOP
                this.moveStop();
                // Position is now unknown — mark as unreliable so the next HomeKit
                // command re-queries the gateway.
                this.initStartPosition = false;
            }, IDENTIFY_JOG_MS);
        });
    }

    setOnline(online: boolean): void {
        this.setFaultOnline(this.windowCoveringService, online);
    }

    private readCachedPosition(): number {
        const raw = (this.accessory.context as Record<string, unknown>).blindPosition;
        return typeof raw === 'number' && Number.isFinite(raw)
            ? Math.min(100, Math.max(0, Math.round(raw)))
            : 0;
    }

    private cachePosition(): void {
        (this.accessory.context as Record<string, unknown>).blindPosition = this.position;
    }

    updateStatus(): void {
        this.log.info(`[${this.id}] Blind updateStatus`);
        if (!this.initStartPosition) {
            if (this.calibrateOnStart) {
                this.log.info(`[${this.id}] Calibrating: move fully down to establish known position`);
                const queued = this.controller.sendCommand({ command: `*2*2*${this.id}##`, log: this.log });
                if (!queued) {
                    this.log.warn('[%s] Blind init DOWN dropped: queue full — calibration deferred', this.id);
                    return;
                }
                this.position = 0;
                this.target = 0;
                this.initPhase = true;
                this.cachePosition();
                // Always send an explicit STOP after the full travel time to guarantee the blind
                // is not left in a moving state. Sending STOP twice (once by the gateway when the
                // end-stop is reached, once by us) is harmless — the motor is already off.
                clearTimeout(this.initTimeout);
                this.initTimeout = setTimeout(() => {
                    this.initTimeout = undefined;
                    this.log.info(`[${this.id}] Init calibration timer elapsed, sending STOP`);
                    this.endCalibration();
                    this.moveStop();
                }, (this.time + this.timeSlat) * 1000 + BLIND_INIT_CALIBRATION_MARGIN_MS);
            } else {
                this.log.info(`[${this.id}] Restoring cached position ${this.position}% (calibrateOnStart disabled)`);
                this.windowCoveringService.updateCharacteristic(this.Characteristic.CurrentPosition, this.position);
                this.windowCoveringService.updateCharacteristic(this.Characteristic.TargetPosition, this.position);
            }
            this.initStartPosition = true;
        } else {
            this.log.info(`[${this.id}] Blind fetching State :${this.state}`);
            this.inStatusQuery = true;
            this.controller.sendCommand({
                command: `*#2*${this.id}##`,
                log: this.log,
                packet: (pkt: string) => {
                    this.onData(pkt);
                },
                done: (_pkt: string | null, _idx: number) => {
                    this.inStatusQuery = false;
                },
            });
        }
    }

    startTimerCommand(): void {
        clearTimeout(this.packetTimeout);
        this.packetTimeout = undefined;
        this.commandSent = true;
    }

    private startConfirmationTimer(): void {
        if (!this.commandSent) return;
        clearTimeout(this.packetTimeout);
        this.packetTimeout = setTimeout(this.endTimerCommand.bind(this), BLIND_COMMAND_ECHO_TIMEOUT_MS);
    }

    endTimerCommand(): void {
        if (this.state !== this.expectedState) {
            this.state = this.expectedState;
            this.log.warn(`[${this.id}] Blind command confirmation not received, forcing state to: ${this.expectedState}`);
            this.updateStatus();
        }
        this.commandSent = false;
        clearTimeout(this.packetTimeout);
    }

    /** Mark the calibration phase as ended. The initTimeout is intentionally NOT cleared
     *  here so the safety STOP fires unconditionally at the end of the travel time, even
     *  when the gateway sends a premature or duplicate STOP. */
    private endCalibration(): void {
        this.initPhase = false;
    }

    moveStop(): void {
        this.log.info(`[${this.id}] Blind sending stop`);
        this.homeKitMovement = false;
        this.expectedState = this.Characteristic.PositionState.STOPPED;
        this.startTimerCommand();
        const queued = this.controller.sendCommand({
            command: `*2*0*${this.id}##`,
            log: this.log,
            started: () => this.startConfirmationTimer(),
        });
        if (!queued) {
            this.log.warn('[%s] Blind STOP dropped: queue full', this.id);
            this.commandSent = false;
        }
    }

    moveUp(): void {
        this.log.info(`[${this.id}] Blind sending move up`);
        this.homeKitMovement = true;
        this.expectedState = this.Characteristic.PositionState.INCREASING;
        this.startTimerCommand();
        const queued = this.controller.sendCommand({
            command: `*2*1*${this.id}##`,
            log: this.log,
            started: () => this.startConfirmationTimer(),
        });
        if (!queued) {
            this.log.warn('[%s] Blind UP dropped: queue full', this.id);
            this.commandSent = false;
            this.homeKitMovement = false;
        }
    }

    moveDown(): void {
        this.log.info(`[${this.id}] Blind sending move down`);
        this.homeKitMovement = true;
        this.expectedState = this.Characteristic.PositionState.DECREASING;
        this.startTimerCommand();
        const queued = this.controller.sendCommand({
            command: `*2*2*${this.id}##`,
            log: this.log,
            started: () => this.startConfirmationTimer(),
        });
        if (!queued) {
            this.log.warn('[%s] Blind DOWN dropped: queue full', this.id);
            this.commandSent = false;
            this.homeKitMovement = false;
        }
    }

    onData(packet: string): void {
        // Match standard *2*<dir>*<id>## OR extended *2*1000#<dir>*<id>## (same direction codes)
        const extract = packet.match(/^\*2\*(?:1000#)?(\d+)\*\d+##$/);
        if (extract) {
            this.log.debug('id:%s onBlind(%s)', this.id, packet);
            const direction = extract[1];
            const prevState = this.state;
            if (direction === '0') {
                const wasDecreasing = this.state === this.Characteristic.PositionState.DECREASING;
                this.state = this.Characteristic.PositionState.STOPPED;
                // End calibration if: not in calibration, OR was actually moving down (normal end),
                // OR position is already 0 (blind was at bottom-stop before calibration move started).
                if (!this.initPhase || wasDecreasing || this.position === 0) {
                    this.endCalibration();
                }
                if (this.homeKitMovement && Math.abs(this.position - this.target) <= 3) {
                    this.position = this.target;
                }
                this.cachePosition();
            } else if (direction === '1') {
                this.state = this.Characteristic.PositionState.INCREASING;
            } else if (direction === '2') {
                this.state = this.Characteristic.PositionState.DECREASING;
            } else {
                this.log.warn('[%s] Blind unknown direction byte %s in packet %s', this.id, direction, packet);
                return;
            }
            this.windowCoveringService.updateCharacteristic(this.Characteristic.PositionState, this.state);
            this.log.debug(`[${this.id}] received state dir:${direction} position:${this.position} target:${this.target}`);

            if (this.commandSent && this.expectedState === this.state) {
                this.log.info(`[${this.id}] expected state ${this.expectedState} reached`);
                this.endTimerCommand();
            } else if (this.homeKitMovement && this.state !== prevState
                    && this.state !== this.expectedState
                    && !this.inStatusQuery) {
                // Physical button pressed while HomeKit movement was in progress — yield immediately
                this.log.info(`[${this.id}] Physical override detected, cancelling HomeKit movement`);
                this.stopMoveTracking();
            }

            // Skip evaluatePosition for duplicate packets that don't change state.
            // For STOP (direction '0'), always evaluate even if positionTimeout is pending —
            // it clears the timeout on entry and syncs CurrentPosition/TargetPosition to HomeKit.
            const isStop = direction === '0';
            if (!this.commandSent && (isStop || !this.positionTimeout) && this.state !== prevState) {
                this.evaluatePosition();
            }
        } else {
            this.log.debug('[%s] Blind ignoring extended packet:%s', this.id, packet);
        }
    }

    evaluatePosition(): void {
        clearTimeout(this.positionTimeout);
        this.positionTimeout = undefined;
        if (this.state === this.Characteristic.PositionState.STOPPED) {
            this.log.info(`[${this.id}] Blind is STOPPED pos:${this.position} target:${this.target}`);
            // Sync TargetPosition to CurrentPosition only when no HomeKit movement is in progress
            // and we are not absorbing a status-query response or a post-confirmation echo.
            if (!this.homeKitMovement && !this.inStatusQuery && this.target !== this.position) {
                this.target = this.position;
                this.windowCoveringService.updateCharacteristic(this.Characteristic.TargetPosition, this.target);
            }
        } else if (this.state === this.Characteristic.PositionState.INCREASING) {
            if (this.position < 100) this.position++;
            if (this.position % 10 === 0 || this.position >= this.target)
                this.log.debug(`[${this.id}] Blind moving UP pos:${this.position} target:${this.target}`);
            if (this.homeKitMovement && this.position >= this.target) {
                this.moveStop();
            } else if (!this.homeKitMovement && this.position >= 100) {
                // physical movement reached upper end-stop — wait for gateway STOP packet
                this.cachePosition();
            } else {
                this.startPositionTracking();
            }
        } else if (this.state === this.Characteristic.PositionState.DECREASING) {
            if (this.position > 0) this.position--;
            if (this.position % 10 === 0 || this.position <= this.target)
                this.log.debug(`[${this.id}] Blind moving DOWN pos:${this.position} target:${this.target}`);
            if (!this.initPhase && this.homeKitMovement && this.position <= this.target) {
                this.moveStop();
            } else if (this.initPhase && this.position === 0) {
                // calibration in progress — initTimeout will fire moveStop after full travel time
            } else if (!this.homeKitMovement && this.position <= 0) {
                // physical movement reached lower end-stop — wait for gateway STOP packet
                this.cachePosition();
            } else {
                this.startPositionTracking();
            }
        }
        this.windowCoveringService.updateCharacteristic(this.Characteristic.CurrentPosition, this.position);
        // Cache at 10% boundaries so position survives Homebridge crash within 10% accuracy.
        if (this.position % 10 === 0) {
            this.cachePosition();
        }
    }

    msPerPercent(position: number): number {
        if (this.slatPercent > 0 && position < this.slatPercent) {
            return Math.max(BLIND_MIN_TICK_MS, (this.timeSlat / this.slatPercent) * 1000);
        }
        return (this.time / Math.max(1, 100 - this.slatPercent)) * 1000;
    }

    startPositionTracking(): void {
        clearTimeout(this.positionTimeout);
        this.positionTimeout = setTimeout(this.evaluatePosition.bind(this), this.msPerPercent(this.position));
    }

    move(): void {
        if (this.commandSent) {
            this.log.info(`[${this.id}] Blind command is still pending: wait for action`);
            this.moveRetries++;
            if (this.moveRetries > BLIND_MAX_MOVE_RETRIES) {
                this.log.warn('[%s] Blind giving up: command stuck pending too long (gateway offline?)', this.id);
                this.stopMoveTracking();
                return;
            }
            clearTimeout(this.moveTrackingTimeout);
            this.moveTrackingTimeout = setTimeout(this.move.bind(this), BLIND_MOVE_RETRY_INTERVAL_MS);
            return;
        }
        if (this.target === this.position) {
            if (this.state !== this.Characteristic.PositionState.STOPPED) {
                this.moveStop();
            }
            this.log.info(`[${this.id}] Blind position is good: stop moving ${this.position} target:${this.target}`);
            return;
        }
        if (this.adjustToward(this.target - this.position)) {
            return;  // STOP issued to reverse direction — wait for echo
        }
        if (!this.commandSent && !this.positionTimeout) {
            this.startPositionTracking();
        }
        this.startMoveTracking();
    }

    /**
     * Drive the blind toward the target by `delta` percentage points.
     * - If currently moving in the OPPOSITE direction, sends STOP and returns true (caller should wait for echo).
     * - If currently STOPPED, sends the appropriate UP/DOWN command and returns false.
     * - If already moving in the CORRECT direction with no command pending and no position tracking,
     *   restores `homeKitMovement` (recovers from rapid retarget) and returns false.
     * Returns true iff caller must return early (STOP issued).
     */
    private adjustToward(delta: number): boolean {
        const goingUp = delta > 0;
        const correctDir  = goingUp ? this.Characteristic.PositionState.INCREASING : this.Characteristic.PositionState.DECREASING;
        const oppositeDir = goingUp ? this.Characteristic.PositionState.DECREASING : this.Characteristic.PositionState.INCREASING;
        if (this.state === oppositeDir) {
            this.moveStop();
            return true;
        }
        if (this.state === this.Characteristic.PositionState.STOPPED) {
            if (goingUp) this.moveUp();
            else         this.moveDown();
            return false;
        }
        // state === correctDir
        if (!this.commandSent && !this.positionTimeout) {
            // Position tracking was cancelled mid-flight (rapid retarget). Re-enable tracking.
            this.homeKitMovement = true;
        }
        return false;
    }

    startMoveTracking(): void {
        clearTimeout(this.moveTrackingTimeout);
        this.moveTrackingTimeout = undefined;
        if (this.moveRetries > BLIND_MAX_MOVE_RETRIES) {
            this.log.warn('[%s] Blind giving up after too many move retries', this.id);
            this.stopMoveTracking();
            return;
        }
        this.moveTrackingTimeout = setTimeout(this.move.bind(this), BLIND_MOVE_RETRY_INTERVAL_MS);
    }

    stopMoveTracking(): void {
        clearTimeout(this.moveTrackingTimeout);
        this.moveTrackingTimeout = undefined;
        clearTimeout(this.positionTimeout);
        this.positionTimeout = undefined;
        clearTimeout(this.packetTimeout);
        this.packetTimeout = undefined;
        clearTimeout(this.statusQueryTimeout);
        this.statusQueryTimeout = undefined;
        clearTimeout(this.initTimeout);
        this.initTimeout = undefined;
        this.inStatusQuery = false;
        this.commandSent = false;
        this.homeKitMovement = false;
        this.initPhase = false;
        this.moveRetries = 0;
    }

    destroy(): void {
        this.stopMoveTracking();
        clearTimeout(this.identifyJogTimeout);
        super.destroy();
    }
}

export class OwnThermostatAccessory extends OwnAccessory {
    zone: number;
    address: string;
    temperature: number;
    targetTemperature: number;
    localOffset: number;
    heatingCoolingState: number;
    targetHeatingCoolingState: number;
    displayUnits: number;
    private thermostatService: InstanceType<typeof Service>;
    private temperatureSensorService: InstanceType<typeof Service>;

    get who(): number { return WHO.temperature; }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ThermostatConfig) {
        if (!config.name) config.name = `thermostat-${config.id}`;
        super(platform, accessory, config);

        if (!Number.isInteger(config.zone) || config.zone <= 0) {
            throw new Error(`homebridge-myhome: thermostat id=${config.id} requires a positive integer "zone"`);
        }
        this.zone = config.zone;
        this.address = `#0#${this.zone}`;

        this.temperature = 0;
        this.targetTemperature = 0;
        this.localOffset = 0;
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
                this.log.info(`[${this.id}] zone[${this.zone}] setTargetHeatingCoolingState:${value}`);
                switch (value) {
                    case this.Characteristic.TargetHeatingCoolingState.HEAT: {
                        const temperature = OwnProtcol.encodeTemperature(this.targetTemperature);
                        this.log.info(`[${this.id}] send Heat Manual at ${temperature}`);
                        this.sendOrThrow(`*#4*${this.address}*#14*${temperature}*1##`);
                        break;
                    }
                    case this.Characteristic.TargetHeatingCoolingState.COOL: {
                        const temperature = OwnProtcol.encodeTemperature(this.targetTemperature);
                        this.log.info(`[${this.id}] send Cool Manual at ${temperature}`);
                        this.sendOrThrow(`*#4*${this.address}*#14*${temperature}*2##`);
                        break;
                    }
                    case this.Characteristic.TargetHeatingCoolingState.OFF:
                        this.log.info(`[${this.id}] send STOP`);
                        this.sendOrThrow(`*4*103*${this.address}##`);
                        break;
                    case this.Characteristic.TargetHeatingCoolingState.AUTO:
                        this.log.info(`[${this.id}] send AUTO`);
                        this.sendOrThrow(`*4*3100*${this.address}##`);
                        break;
                }
                this.targetHeatingCoolingState = value as number;
            });

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: -50, maxValue: 50, minStep: 0.1 })
            .onGet(() => this.temperature);

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: 5, minStep: 0.5, maxValue: 30 })
            .onGet(() => this.targetTemperature)
            .onSet((value: CharacteristicValue) => {
                this.log.info(`[${this.id}] zone[${this.zone}] setTargetTemperature:${value}`);
                const isHeat = this.targetHeatingCoolingState === this.Characteristic.TargetHeatingCoolingState.HEAT;
                const isCool = this.targetHeatingCoolingState === this.Characteristic.TargetHeatingCoolingState.COOL;
                if (!isHeat && !isCool) {
                    this.log.error("Can't change target temperature with mode (%s)", this.targetHeatingCoolingState);
                    throw new this.HapStatusError(this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
                }
                const temperature = OwnProtcol.encodeTemperature(value as number);
                const modeByte = isCool ? '2' : '1';
                this.sendOrThrow(`*#4*${this.address}*#14*${temperature}*${modeByte}##`);
                this.targetTemperature = value as number;
            });

        this.thermostatService.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .onGet(() => this.displayUnits)
            .onSet((value: CharacteristicValue) => { this.displayUnits = value as number; });
    }

    setOnline(online: boolean): void {
        this.setFaultOnline(this.thermostatService, online);
    }

    updateStatus(): void {
        this.log.info(`[${this.id}] Thermostat updateStatus`);
        const handler = (pkt: string) => { this.onData(pkt); };
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
    }

    updateCharacteristicTargetTemperature(temperature: number): void {
        this.log.info(`[${this.id}] update TargetTemperature (${temperature})`);
        this.targetTemperature = temperature;
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetTemperature, this.targetTemperature);
    }

    updateCharacteristicTargetHeatingCoolingState(state: number): void {
        this.log.info(`[${this.id}] update TargetHeatingCoolingState (${state})`);
        this.targetHeatingCoolingState = state;
        this.thermostatService.updateCharacteristic(this.Characteristic.TargetHeatingCoolingState, this.targetHeatingCoolingState);
    }

    updateCharacteristicCurrentHeatingCoolingState(state: number): void {
        this.log.info(`[${this.id}] update CurrentHeatingCoolingState (${state})`);
        this.heatingCoolingState = state;
        this.thermostatService.updateCharacteristic(this.Characteristic.CurrentHeatingCoolingState, this.heatingCoolingState);
    }

    onData(packet: string): void {
        let extract: RegExpMatchArray | null;
        if ((extract = packet.match(/^\*#4\*\d+\*0\*(\d+)##$/))) {
            this.updateCharacteristicCurrentTemperature(OwnProtcol.decodeTemperature(extract[1]));
        } else if ((extract = packet.match(/^\*#4\*\d+\*12\*(\d+)\*3##$/))) {
            const probeTemp = OwnProtcol.decodeTemperature(extract[1]);
            this.log.debug(`[${this.id}] zone[${this.zone}] probe temperature with local offset (${probeTemp})`);
        } else if ((extract = packet.match(/^\*#4\*\d+\*13\*(\d+)##$/))) {
            let status = 'Local ON';
            const value = extract[1];
            if (value === '00') this.localOffset = 0;
            else if (value === '01') this.localOffset = 1;
            else if (value === '11') this.localOffset = -1;
            else if (value === '02') this.localOffset = 2;
            else if (value === '12') this.localOffset = -2;
            else if (value === '03') this.localOffset = 3;
            else if (value === '13') this.localOffset = -3;
            else if (value === '04') { this.localOffset = 0; status = 'Local OFF'; }
            else if (value === '05') { this.localOffset = 0; status = 'Local protection'; }
            else { this.log.warn('[%s] zone[%s] unknown DIM 13 value (%s) in packet: %s', this.id, this.zone, value, packet); }
            this.log.debug('[%s] zone[%s] local offset:%s (%s)', this.id, this.zone, this.localOffset, status);
        } else if ((extract = packet.match(/^\*#4\*[\d#]+\*14\*(\d+)\*\d+##$/))) {
            this.updateCharacteristicTargetTemperature(OwnProtcol.decodeTemperature(extract[1]));
        } else if ((extract = packet.match(/^\*#4\*[\d#]+\*19\*(\d)\*(\d)##$/))) {
            const CV = extract[1];
            const HV = extract[2];
            const coolingActive = ['1', '2'].includes(CV);
            const heatingActive = ['1', '2'].includes(HV);
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
            let status = '';
            const value = extract[1];
            if (value === '0') status = 'OFF';
            else if (value === '1') status = 'ON';
            else if (value === '4') status = 'STOP';
            else status = `not decoded:${value}`;
            this.log.debug(`[${this.id}] zone[${this.zone}] actuator status (${status})`);
        } else if ((extract = packet.match(/^\*4\*(\d+)\*\d+##$/))) {
            let status = '';
            const value = extract[1];
            if (value === '0') status = 'Conditioning';
            else if (value === '1') status = 'Heating';
            else if (value === '102') status = 'Antifreeze';
            else if (value === '202') status = 'Thermal Protection';
            else if (value === '303') status = 'Generic OFF';
            else this.log.error('[%s] zone[%s] operation mode (%s)', this.id, this.zone, value);
            this.log.debug(`[${this.id}] zone[${this.zone}] operation mode (${status})`);
            const hkCurrentState = (value === '1' || value === '102')
                ? this.Characteristic.CurrentHeatingCoolingState.HEAT
                : (value === '0')
                    ? this.Characteristic.CurrentHeatingCoolingState.COOL
                    : this.Characteristic.CurrentHeatingCoolingState.OFF;
            this.updateCharacteristicCurrentHeatingCoolingState(hkCurrentState);
        } else if ((extract = packet.match(/^\*4\*(\d+)\*#\d+#\d+##$/))) {
            const valInt = parseInt(extract[1], 10);
            if (valInt === 103) {
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.OFF);
                this.log.debug('[%s] zone[%s] operation mode Heating OFF', this.id, this.zone);
            } else if (valInt === 102) {
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.OFF);
                this.log.debug('[%s] zone[%s] operation mode Anti Freeze', this.id, this.zone);
            } else if (valInt === 1101 || valInt === 1102 || valInt === 1103) {
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.AUTO);
                this.log.debug('[%s] zone[%s] operation mode Heating program', this.id, this.zone);
            } else if (valInt > 13000 && valInt <= 13255) {
                const days = valInt - 13000;
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.AUTO);
                this.log.debug('[%s] zone[%s] operation mode Holiday program for %s day', this.id, this.zone, days);
            } else if (valInt === 21) {
                this.log.debug('[%s] zone[%s] Remote control enabled', this.id, this.zone);
            } else if (valInt === 0) {
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.COOL);
                this.log.debug('[%s] zone[%s] operation mode Conditioning', this.id, this.zone);
            } else {
                this.log.error('[%s] zone[%s] unknown value (%i) in packet: %s', this.id, this.zone, valInt, packet);
            }
        } else if ((extract = packet.match(/^\*4\*(\d+)#(\d+)\*#\d+#\d+##$/))) {
            const value = extract[1];
            if (value === '110') {
                const temp = OwnProtcol.decodeTemperature(extract[2]);
                this.log.debug('[%s] zone[%s] operation mode Manual Heating (%s)', this.id, this.zone, temp);
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.HEAT);
                this.updateCharacteristicTargetTemperature(temp);
            } else if (value === '210') {
                const temp = OwnProtcol.decodeTemperature(extract[2]);
                this.log.debug('[%s] zone[%s] operation mode Manual Cooling (%s)', this.id, this.zone, temp);
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.COOL);
                this.updateCharacteristicTargetTemperature(temp);
            }
        } else {
            this.log.error('[%s] zone[%s] unknown packet: %s', this.id, this.zone, packet);
        }
    }
}

export class OwnScenarioAccessory extends OwnAccessory {
    private resetTimeout: ReturnType<typeof setTimeout> | undefined;
    private asButton: boolean;
    private service: InstanceType<typeof Service>;

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ScenarioConfig) {
        if (!config.name) config.name = `scenario-${config.id}`;
        super(platform, accessory, config);

        this.resetTimeout = undefined;
        this.asButton = config.asButton ?? false;

        if (this.asButton) {
            // Stateless programmable switch — semantically correct for momentary scenarios.
            // The Home app shows it as a button rather than a toggle switch.
            this.service = this.initPrimaryService(this.Service.StatelessProgrammableSwitch, 'Scenario');
            this.service.getCharacteristic(this.Characteristic.ProgrammableSwitchEvent)
                .setProps({ validValues: [this.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS] });
            // Remove any previously-registered Switch service from this accessory so the
            // accessory presents only one primary service after a config flip.
            const existingSwitch = this.accessory.getService(this.Service.Switch);
            if (existingSwitch) this.accessory.removeService(existingSwitch);
        } else {
            // Legacy mode — Switch with auto-reset (preserved for compatibility with existing automations).
            this.service = this.initPrimaryService(this.Service.Switch, 'Scenario');
            this.service.getCharacteristic(this.Characteristic.On)
                .onGet(() => false)
                .onSet((value: CharacteristicValue) => {
                    if (value) this.activate();
                });
            // Remove a previously-registered StatelessProgrammableSwitch (asButton flipped true→false)
            const existingSPS = this.accessory.getService(this.Service.StatelessProgrammableSwitch);
            if (existingSPS) this.accessory.removeService(existingSPS);
        }
    }

    private activate(): void {
        this.log.info(`[${this.id}] Scenario activate`);
        this.sendOrThrow(`*0*${this.id}*0##`);
        if (this.asButton) {
            this.service.updateCharacteristic(
                this.Characteristic.ProgrammableSwitchEvent,
                this.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
            );
        } else {
            clearTimeout(this.resetTimeout);
            this.resetTimeout = setTimeout(() => {
                this.service.updateCharacteristic(this.Characteristic.On, false);
            }, SCENARIO_RESET_MS);
        }
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

    get who(): number { return WHO.auxiliary; }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ContactConfig) {
        if (!config.name) config.name = `contact-${config.id}`;
        super(platform, accessory, config);

        this.sensorType = config.sensorType ?? 'contact';
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
            command: `*#9*${this.id}##`,
            log: this.log,
            packet: (pkt: string) => { this.onData(pkt); },
        });
    }

    onData(packet: string): void {
        const extract = packet.match(/^\*9\*(\d+)\*\d+##$/);
        if (extract) {
            this.contactState = extract[1] === '0'
                ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
                : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
            this.log.info(`[${this.id}] ${this.sensorType} state: ${this.contactState}`);
            this.sensorService.updateCharacteristic(this.stateChar, this.mapStateForSensor(this.contactState));
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
    private destroyed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private eveWattsChar: any;

    get who(): number { return WHO.energy; }

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: EnergyConfig) {
        if (!config.name) config.name = `energy-${config.id}`;
        super(platform, accessory, config);

        this.watts = ENERGY_MIN_LIGHT_LEVEL;
        this.asOutlet = config.asOutlet ?? false;

        if (this.asOutlet) {
            this.energyService = this.initPrimaryService(this.Service.Outlet, 'EnergyMonitor', true, true);
            this.energyService.getCharacteristic(this.Characteristic.On)
                .onGet(() => this.watts > ENERGY_OUTLET_IN_USE_THRESHOLD_W)
                .onSet(() => { /* read-only meter — ignore writes */ });
            this.energyService.getCharacteristic(this.Characteristic.OutletInUse)
                .onGet(() => this.watts > ENERGY_OUTLET_IN_USE_THRESHOLD_W);
            // Eve custom characteristic for watts
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Char = (this.Characteristic as unknown as { new (...args: any[]): any });
            try {
                const eveChar = new Char('Eve Consumption', EVE_CONSUMPTION_UUID, {
                    format: 'float', perms: ['ev', 'pr'], unit: 'W',
                    minValue: 0, maxValue: 100000, minStep: 0.1,
                });
                this.energyService.addCharacteristic(eveChar);
                this.eveWattsChar = eveChar;
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

    setOnline(online: boolean): void {
        this.setFaultOnline(this.energyService, online, true);
    }

    destroy(): void {
        this.destroyed = true;
        clearInterval(this.pollInterval);
        this.eveWattsChar = null;
        super.destroy();
    }

    updateStatus(): void {
        if (this.destroyed) return;
        this.log.debug(`[${this.id}] Energy updateStatus`);
        this.controller.sendCommand({
            command: `*#18*${this.id}*113##`,
            log: this.log,
            packet: (pkt: string) => { this.onData(pkt); },
        });
    }

    onData(packet: string): void {
        if (this.destroyed) return;
        const extract = packet.match(/^\*#18\*\d+\*113\*(\d+)##$/);
        if (extract) {
            this.watts = Math.max(ENERGY_MIN_LIGHT_LEVEL, parseInt(extract[1], 10));
            this.log.debug(`[${this.id}] Energy: ${this.watts}W`);
            if (this.asOutlet) {
                const inUse = this.watts > ENERGY_OUTLET_IN_USE_THRESHOLD_W;
                this.energyService.updateCharacteristic(this.Characteristic.On, inUse);
                this.energyService.updateCharacteristic(this.Characteristic.OutletInUse, inUse);
                if (this.eveWattsChar) {
                    this.energyService.updateCharacteristic(this.eveWattsChar, this.watts);
                }
            } else {
                this.energyService.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, this.watts);
            }
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
        if (!config.name) config.name = `door-${config.id}`;
        super(platform, accessory, config);

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
                if (value !== this.Characteristic.LockTargetState.UNSECURED) return;
                this.log.info(`[${this.id}] Door open`);
                this.sendOrThrow(this.openCommand);
                this.currentLockState = this.Characteristic.LockCurrentState.UNSECURED;
                this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.currentLockState);
                clearTimeout(this.resetTimeout);
                this.resetTimeout = setTimeout(() => {
                    this.resetTimeout = undefined;
                    this.currentLockState = this.Characteristic.LockCurrentState.SECURED;
                    this.lockService.updateCharacteristic(this.Characteristic.LockTargetState,
                        this.Characteristic.LockTargetState.SECURED);
                    this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState,
                        this.currentLockState);
                }, DOOR_RESET_MS);
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
    }

    destroy(): void {
        clearTimeout(this.resetTimeout);
        super.destroy();
    }
}

