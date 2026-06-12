import type { Characteristic, CharacteristicValue, HapStatusError, Logging, PlatformAccessory, Service } from 'homebridge';
import type { OwnClient } from './OwnNet';
import { OwnProtcol } from './OwnProtcol';
import { PLUGIN_VERSION } from './constants';
import {
    brightnessToOwnLevel,
    ownLevelToBrightness,
    IDENTIFY_BLINK_MS,
    SCENARIO_RESET_MS,
    BLIND_MOVE_RETRY_INTERVAL_MS,
    BLIND_MAX_MOVE_RETRIES,
    BLIND_COMMAND_ECHO_TIMEOUT_MS,
    BLIND_ECHO_GRACE_WINDOW_MS,
    BLIND_INIT_CALIBRATION_MARGIN_MS,
    BLIND_QUEUE_BUSY_THRESHOLD,
    ENERGY_POLL_INTERVAL_MS,
    ENERGY_POLL_QUEUE_THRESHOLD,
} from './utils';

export interface OwnPlatformLike {
    log: Logging;
    controller: OwnClient;
    Service: typeof Service;
    Characteristic: typeof Characteristic;
    HapStatusError: new (status: number) => HapStatusError;
    HAPStatus: Record<string, number>;
}

export interface BaseConfig {
    id: number;
    name?: string;
}

export interface LightConfig extends BaseConfig {
    dimmer?: boolean;
}

export interface BlindConfig extends BaseConfig {
    time: number;
    timeSlat?: number;
    slatPercent?: number;
}

export interface ThermostatConfig extends BaseConfig {
    zone: number;
}

export interface ScenarioConfig extends BaseConfig {
    asButton?: boolean;
}
export interface ContactConfig extends BaseConfig {
    sensorType?: 'contact' | 'motion' | 'occupancy';
}
export interface EnergyConfig extends BaseConfig {
    asOutlet?: boolean;
}

class OwnAccessory {
    protected log: Logging;
    protected controller: OwnClient;
    protected Service: typeof Service;
    protected Characteristic: typeof Characteristic;
    protected HapStatusError: new (status: number) => HapStatusError;
    protected HAPStatus: Record<string, number>;
    accessory: PlatformAccessory;
    name: string;
    protected id: number;
    protected fault = false;

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: BaseConfig) {
        this.log = platform.log;
        this.controller = platform.controller;
        this.Service = platform.Service;
        this.Characteristic = platform.Characteristic;
        this.HapStatusError = platform.HapStatusError;
        this.HAPStatus = platform.HAPStatus;
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
        if (!this.controller.sendCommand({ command, log: this.log })) {
            throw new this.HapStatusError(this.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    }

    updateStatus(): void {
        this.log.info(`[${this.id}] Accessory updateStatus`);
    }

    onData(packet: string): void {
        this.log.debug('OwnAccessory.OnData', packet);
    }

    checkWhere(where: string): boolean {
        const id = parseInt(where, 10);
        return this.id === id;
    }

    setOnline(_online: boolean): void {}

    destroy(): void {}
}

export class OwnLightAccessory extends OwnAccessory {
    value: boolean;
    dimmer: boolean;
    brightness: number;
    private lightbulbService: InstanceType<typeof Service>;

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: LightConfig) {
        if (!config.name) config.name = `light-${config.id}`;
        super(platform, accessory, config);

        this.value = false;
        this.dimmer = config.dimmer ?? false;
        this.brightness = 100;

        this.accessory.removeAllListeners('identify');
        this.accessory.on('identify', () => {
            this.log.info(`[${this.id}] Identify — blink`);
            const wasOn = this.value;
            this.controller.sendCommand({ command: `*1*0*${this.id}##`, log: this.log });
            setTimeout(() => {
                if (wasOn) this.controller.sendCommand({ command: `*1*1*${this.id}##`, log: this.log });
            }, IDENTIFY_BLINK_MS);
        });

        this.lightbulbService = this.initPrimaryService(this.Service.Lightbulb, 'Light', true);

        this.lightbulbService.getCharacteristic(this.Characteristic.On)
            .onGet(() => this.value)
            .onSet((value: CharacteristicValue) => {
                this.log.info(`[${this.id}] Setting power state to ${value ? 'on' : 'off'}`);
                if (value && this.dimmer) {
                    const level = brightnessToOwnLevel(this.brightness);
                    this.sendOrThrow(`*1*${level}*${this.id}##`);
                } else {
                    this.sendOrThrow(`*1*${value ? '1' : '0'}*${this.id}##`);
                }
                this.value = value as boolean;
            });

        if (this.dimmer) {
            this.lightbulbService.getCharacteristic(this.Characteristic.Brightness)
                .onGet(() => this.brightness)
                .onSet((value: CharacteristicValue) => {
                    this.log.info(`[${this.id}] Setting brightness to ${value}`);
                    if (value === 0) {
                        this.sendOrThrow(`*1*0*${this.id}##`);
                        this.brightness = 0;
                        this.value = false;
                        this.lightbulbService.updateCharacteristic(this.Characteristic.On, false);
                    } else {
                        const level = brightnessToOwnLevel(value as number);
                        this.sendOrThrow(`*1*${level}*${this.id}##`);
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
            command: `*#1*${this.id}##`,
            log: this.log,
            packet: (pkt: string) => {
                const m = pkt.match(/^\*#1\*\d+\*1\*(\d+)##$/);
                if (m) this.onData(`*1*${m[1]}*${this.id}##`);
            },
        });
    }

    onData(packet: string): void {
        // Extended scenario/automation format *1*1000#<level>*<id>## — treat sub-level as the effective level
        const ext = packet.match(/^\*1\*1000#(\d+)\*\d+##$/);
        const extract = ext ?? packet.match(/^\*1\*(\d+)\*\d+##$/);
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
    private inStatusQuery: boolean;
    private statusQueryTimeout: ReturnType<typeof setTimeout> | undefined;
    private initTimeout: ReturnType<typeof setTimeout> | undefined;
    private windowCoveringService: InstanceType<typeof Service>;

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: BlindConfig) {
        if (!config.name) config.name = `blind-${config.id}`;
        super(platform, accessory, config);

        if (!config.time || config.time <= 0) {
            throw new Error(`homebridge-myhome: blind id=${config.id} requires a positive "time" value`);
        }
        this.time = config.time;
        this.timeSlat = config.timeSlat ?? 0;
        this.slatPercent = config.slatPercent ?? 0;

        this.state = this.Characteristic.PositionState.STOPPED;
        this.expectedState = this.Characteristic.PositionState.STOPPED;
        this.position = 0;
        this.initStartPosition = false;
        this.commandSent = false;
        this.target = 0;
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
    }

    setOnline(online: boolean): void {
        this.setFaultOnline(this.windowCoveringService, online);
    }

    updateStatus(): void {
        this.log.info(`[${this.id}] Blind updateStatus`);
        if (!this.initStartPosition) {
            this.log.info(`[${this.id}] Initialization phase of blind: reset position to 0 and send move down`);
            this.controller.sendCommand({ command: `*2*2*${this.id}##`, log: this.log });
            this.position = 0;
            this.target = 0;
            this.initPhase = true;
            this.initStartPosition = true;
            // Send explicit STOP after the full travel time to terminate calibration,
            // even if the gateway never broadcasts a STOP packet at the end-stop.
            // For venetian blinds, full travel = linear time + slat rotation time.
            clearTimeout(this.initTimeout);
            this.initTimeout = setTimeout(() => {
                this.initTimeout = undefined;
                if (this.initPhase) {
                    this.log.info(`[${this.id}] Init calibration timer elapsed, sending STOP`);
                    this.initPhase = false;
                    this.moveStop();
                }
            }, (this.time + this.timeSlat) * 1000 + BLIND_INIT_CALIBRATION_MARGIN_MS);
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
        } else if (this.homeKitMovement) {
            // Absorb gateway echo packets (old-format STOP arriving after UP/DOWN confirmation)
            this.inStatusQuery = true;
            clearTimeout(this.statusQueryTimeout);
            this.statusQueryTimeout = setTimeout(() => { this.inStatusQuery = false; }, BLIND_ECHO_GRACE_WINDOW_MS);
        }
        this.commandSent = false;
        clearTimeout(this.packetTimeout);
    }

    commandIsPending(): boolean {
        return this.commandSent;
    }

    moveStop(): void {
        this.log.info(`[${this.id}] Blind sending stop`);
        this.homeKitMovement = false;
        this.expectedState = this.Characteristic.PositionState.STOPPED;
        this.startTimerCommand();
        this.controller.sendCommand({
            command: `*2*0*${this.id}##`,
            log: this.log,
            started: () => this.startConfirmationTimer(),
        });
    }

    moveUp(): void {
        this.log.info(`[${this.id}] Blind sending move up`);
        this.homeKitMovement = true;
        this.expectedState = this.Characteristic.PositionState.INCREASING;
        this.startTimerCommand();
        this.controller.sendCommand({
            command: `*2*1*${this.id}##`,
            log: this.log,
            started: () => this.startConfirmationTimer(),
        });
    }

    moveDown(): void {
        this.log.info(`[${this.id}] Blind sending move down`);
        this.homeKitMovement = true;
        this.expectedState = this.Characteristic.PositionState.DECREASING;
        this.startTimerCommand();
        this.controller.sendCommand({
            command: `*2*2*${this.id}##`,
            log: this.log,
            started: () => this.startConfirmationTimer(),
        });
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
                if (!this.initPhase || wasDecreasing) {
                    this.initPhase = false;
                }
                if (Math.abs(this.position - this.target) <= 3) {
                    this.position = this.target;
                }
            } else if (direction === '1') {
                this.state = this.Characteristic.PositionState.INCREASING;
            } else if (direction === '2') {
                this.state = this.Characteristic.PositionState.DECREASING;
            } else {
                this.log.warn('[%s] Blind unknown direction byte %s in packet %s', this.id, direction, packet);
                return;
            }
            this.windowCoveringService.updateCharacteristic(this.Characteristic.PositionState, this.state);
            this.log.info(`[${this.id}] received state dir:${direction} position:${this.position} target:${this.target}`);

            if (this.commandIsPending() && this.expectedState === this.state) {
                this.log.info(`[${this.id}] expected state ${this.expectedState} reached`);
                this.endTimerCommand();
            } else if (this.homeKitMovement && this.state !== prevState
                    && this.state !== this.expectedState
                    && !this.inStatusQuery) {
                // Physical button pressed while HomeKit movement was in progress — yield immediately
                this.log.info(`[${this.id}] Physical override detected, cancelling HomeKit movement`);
                this.stopMoveTracking();
            }

            // Skip evaluatePosition for duplicate packets that don't change state
            if (!this.commandIsPending() && !this.positionTimeout && this.state !== prevState) {
                this.evaluatePosition();
            }
        } else {
            this.log.debug('[%s] Blind ignoring extended packet:%s', this.id, packet);
        }
    }

    evaluatePosition(): void {
        clearTimeout(this.positionTimeout);
        if (this.state === this.Characteristic.PositionState.STOPPED) {
            this.log.info(`[${this.id}] Blind is STOPPED pos:${this.position} target:${this.target}`);
            // Sync TargetPosition to CurrentPosition only when no HomeKit movement is in progress
            // and we are not absorbing a status-query response (which only reports gateway state,
            // not HomeKit intent). Skip during active HomeKit movement to preserve the user target.
            if (!this.homeKitMovement && !this.inStatusQuery && this.target !== this.position) {
                this.target = this.position;
                this.windowCoveringService.updateCharacteristic(this.Characteristic.TargetPosition, this.target);
            }
        } else if (this.state === this.Characteristic.PositionState.INCREASING) {
            if (this.position < 100) this.position++;
            if (this.position % 10 === 0 || this.position >= this.target)
                this.log.info(`[${this.id}] Blind moving UP pos:${this.position} target:${this.target}`);
            if (this.homeKitMovement && this.position >= this.target) {
                this.moveStop();
            } else if (!this.homeKitMovement && this.position >= 100) {
                // physical movement reached upper end-stop — wait for gateway STOP packet
            } else {
                this.startPositionTracking();
            }
        } else if (this.state === this.Characteristic.PositionState.DECREASING) {
            if (this.position > 0) this.position--;
            if (this.position % 10 === 0 || this.position <= this.target)
                this.log.info(`[${this.id}] Blind moving DOWN pos:${this.position} target:${this.target}`);
            if (!this.initPhase && this.homeKitMovement && this.position <= this.target) {
                this.moveStop();
            } else if (this.initPhase && this.position === 0) {
                // calibration in progress — initTimeout will fire moveStop after full travel time
            } else if (!this.homeKitMovement && this.position <= 0) {
                // physical movement reached lower end-stop — wait for gateway STOP packet
            } else {
                this.startPositionTracking();
            }
        }
        this.windowCoveringService.updateCharacteristic(this.Characteristic.CurrentPosition, this.position);
    }

    msPerPercent(position: number): number {
        if (this.slatPercent > 0 && position < this.slatPercent) {
            return Math.max(50, (this.timeSlat / this.slatPercent) * 1000);
        }
        return (this.time / Math.max(1, 100 - this.slatPercent)) * 1000;
    }

    startPositionTracking(): void {
        clearTimeout(this.positionTimeout);
        this.positionTimeout = setTimeout(this.evaluatePosition.bind(this), this.msPerPercent(this.position));
    }

    move(): void {
        if (this.commandIsPending()) {
            this.log.info(`[${this.id}] Blind command is still pending: wait for action`);
            clearTimeout(this.moveTrackingTimeout);
            this.moveTrackingTimeout = setTimeout(this.move.bind(this), BLIND_MOVE_RETRY_INTERVAL_MS);
            return;
        }
        if (this.target < this.position) {
            if (this.state === this.Characteristic.PositionState.INCREASING) {
                this.moveStop();
            } else if (this.state !== this.Characteristic.PositionState.DECREASING &&
                (this.state === this.Characteristic.PositionState.STOPPED || Math.abs(this.target - this.position) > 2)) {
                this.moveDown();
            }
        } else if (this.target > this.position) {
            if (this.state === this.Characteristic.PositionState.DECREASING) {
                this.moveStop();
            } else if (this.state !== this.Characteristic.PositionState.INCREASING &&
                (this.state === this.Characteristic.PositionState.STOPPED || Math.abs(this.target - this.position) > 2)) {
                this.moveUp();
            }
        } else {
            if (this.state !== this.Characteristic.PositionState.STOPPED) {
                this.moveStop();
            }
            this.log.info(`[${this.id}] Blind position is good: stop moving ${this.position} target:${this.target}`);
            return;
        }
        if (!this.commandSent && !this.positionTimeout) {
            this.startPositionTracking();
        }
        this.startMoveTracking();
    }

    startMoveTracking(): void {
        clearTimeout(this.moveTrackingTimeout);
        this.moveTrackingTimeout = undefined;
        if (this.commandSent) {
            this.moveRetries++;
        }
        if (this.moveRetries > BLIND_MAX_MOVE_RETRIES) {
            this.log.warn('[%s] Blind giving up after too many move retries', this.id);
            this.moveRetries = 0;
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
        this.thermostatService.addLinkedService(this.temperatureSensorService);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.heatingCoolingState);

        this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1, 3] })
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
            .setProps({ minValue: -50, maxValue: 50 })
            .onGet(() => this.temperature);

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: 5, minStep: 0.5, maxValue: 30 })
            .onGet(() => this.targetTemperature)
            .onSet((value: CharacteristicValue) => {
                this.log.info(`[${this.id}] zone[${this.zone}] setTargetTemperature:${value}`);
                if (this.targetHeatingCoolingState !== this.Characteristic.TargetHeatingCoolingState.HEAT) {
                    this.log.error("Can't change target temperature with mode (%s)", this.targetHeatingCoolingState);
                    throw new this.HapStatusError(this.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
                }
                const temperature = OwnProtcol.encodeTemperature(value as number);
                this.sendOrThrow(`*#4*${this.address}*#14*${temperature}*1##`);
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
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.OFF);
                this.log.debug('[%s] zone[%s] operation mode Conditioning (generic OFF)', this.id, this.zone);
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
    destroy(): void { clearTimeout(this.resetTimeout); }
}

export class OwnContactAccessory extends OwnAccessory {
    contactState: number;
    private sensorType: 'contact' | 'motion' | 'occupancy';
    private sensorService: InstanceType<typeof Service>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private stateChar: any;

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: ContactConfig) {
        if (!config.name) config.name = `contact-${config.id}`;
        super(platform, accessory, config);

        this.sensorType = config.sensorType ?? 'contact';
        this.contactState = this.Characteristic.ContactSensorState.CONTACT_DETECTED;

        // Pick the appropriate HomeKit service based on the sensor type
        let serviceClass: typeof Service;
        let modelName: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let stateCharacteristicClass: any;
        switch (this.sensorType) {
            case 'motion':
                serviceClass = this.Service.MotionSensor;
                modelName = 'MotionSensor';
                stateCharacteristicClass = this.Characteristic.MotionDetected;
                break;
            case 'occupancy':
                serviceClass = this.Service.OccupancySensor;
                modelName = 'OccupancySensor';
                stateCharacteristicClass = this.Characteristic.OccupancyDetected;
                break;
            default:
                serviceClass = this.Service.ContactSensor;
                modelName = 'ContactSensor';
                stateCharacteristicClass = this.Characteristic.ContactSensorState;
        }

        this.sensorService = this.initPrimaryService(serviceClass, modelName, true, true);
        this.stateChar = stateCharacteristicClass;

        this.sensorService.getCharacteristic(stateCharacteristicClass)
            .onGet(() => this.mapStateForSensor(this.contactState));
    }

    private mapStateForSensor(rawState: number): boolean | number {
        if (this.sensorType === 'contact') {
            return rawState; // 0=DETECTED, 1=NOT_DETECTED
        }
        // For motion/occupancy: contact CLOSED (0) → no motion/no occupancy; OPEN (1) → motion/occupancy
        return rawState !== this.Characteristic.ContactSensorState.CONTACT_DETECTED;
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

    constructor(platform: OwnPlatformLike, accessory: PlatformAccessory, config: EnergyConfig) {
        if (!config.name) config.name = `energy-${config.id}`;
        super(platform, accessory, config);

        this.watts = 0.0001;
        this.asOutlet = config.asOutlet ?? false;

        if (this.asOutlet) {
            this.energyService = this.initPrimaryService(this.Service.Outlet, 'EnergyMonitor', true, true);
            this.energyService.getCharacteristic(this.Characteristic.On)
                .onGet(() => this.watts > 1)
                .onSet(() => { /* read-only meter — ignore writes */ });
            this.energyService.getCharacteristic(this.Characteristic.OutletInUse)
                .onGet(() => this.watts > 1);
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
            } catch {
                this.log.debug('[%s] Eve consumption characteristic unavailable in this hap version', this.id);
            }
            // Remove a previously-registered LightSensor service if config flipped
            const existing = this.accessory.getService(this.Service.LightSensor);
            if (existing) this.accessory.removeService(existing);
        } else {
            // Legacy mode: lux-hack on LightSensor (preserves existing automations)
            this.energyService = this.initPrimaryService(this.Service.LightSensor, 'EnergyMonitor', true, true);
            this.energyService.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
                .onGet(() => Math.max(0.0001, this.watts));
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
        const extract = packet.match(/^\*#18\*\d+\*113\*(\d+)##$/);
        if (extract) {
            this.watts = Math.max(0.0001, parseInt(extract[1], 10));
            this.log.debug(`[${this.id}] Energy: ${this.watts}W`);
            if (this.asOutlet) {
                const inUse = this.watts > 1;
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
