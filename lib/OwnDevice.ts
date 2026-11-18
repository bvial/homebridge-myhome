/** Protocol-neutral view of a MyHome device shared by its HomeKit and Matter adapters. */
export type DeviceKind = 'light' | 'blind' | 'thermostat' | 'scenario' | 'contact' | 'energy' | 'door';

/** `auto` is the MyHome scheduled programme, not Matter's automatic heat/cool mode. */
export type DeviceMode = 'off' | 'heat' | 'cool' | 'auto';

export interface DeviceState {
    name: string;
    online: boolean;
    on?: boolean;
    brightness?: number;
    /** Percent open: 0 = closed, 100 = open. */
    position?: number;
    targetPosition?: number;
    moving?: 'opening' | 'closing' | 'stopped';
    positionConfidence?: 'unknown' | 'estimated' | 'calibrated' | 'measured';
    blindPhase?: import('./OwnBlindController').BlindPhase;
    calibrating?: boolean;
    /** Temperatures are expressed in degrees Celsius. */
    temperature?: number;
    targetTemperature?: number;
    mode?: DeviceMode;
    activeMode?: Exclude<DeviceMode, 'auto'>;
    /** An open contact is triggered; this also covers motion/leak/smoke/CO inputs. */
    triggered?: boolean;
    watts?: number;
    /** Relay state only: the existing door device has no physical lock feedback. */
    locked?: boolean;
}

export type DeviceCommand =
    | { type: 'power'; value: boolean }
    | { type: 'brightness' | 'position' | 'temperature'; value: number }
    | { type: 'mode'; value: DeviceMode }
    | { type: 'stop' | 'activate' | 'unlock' | 'identify' | 'calibrate' };

export type DeviceEvent =
    | { type: 'state'; state: DeviceState }
    | { type: 'command'; command: DeviceCommand }
    | { type: 'doorbell' };

/** Cancel an asynchronous command producer's work before it reaches the gateway. */
export interface DeviceCommandOptions {
    signal?: AbortSignal;
}

export interface OwnDevice {
    snapshot(): DeviceState;
    execute(command: DeviceCommand, options?: DeviceCommandOptions): void | Promise<void>;
    subscribe(listener: (event: DeviceEvent) => void): () => void;
}
