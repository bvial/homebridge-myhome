import type { OwnPlatformLike } from '../lib/OwnAccessory';
import { Socket } from 'node:net';
import { OwnClient, OwnConnection, PKT, STATE, type CommandParams } from '../lib/OwnNet';

export const POSITION_STATE = { DECREASING: 0, INCREASING: 1, STOPPED: 2 } as const;
export const HEATING_COOLING_CURRENT = { OFF: 0, HEAT: 1, COOL: 2 } as const;
export const HEATING_COOLING_TARGET = { OFF: 0, HEAT: 1, COOL: 2, AUTO: 3 } as const;
export const CONTACT_STATE = { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 } as const;

function noop(): void {}

export interface Spy {
    (...args: unknown[]): unknown;
    calls: unknown[][];
}

export function makeSpy(returnValue?: unknown): Spy {
    const calls: unknown[][] = [];
    const fn = function (...args: unknown[]) { calls.push(args); return returnValue; } as Spy;
    fn.calls = calls;
    return fn;
}

function makeCharacteristicStub() {
    const stub: Record<string, unknown> & {
        value: unknown;
        props: unknown;
        getter?: () => unknown;
        setter?: (v: unknown) => void | Promise<void>;
        onGet: (fn: () => unknown) => typeof stub;
        onSet: (fn: (v: unknown) => void | Promise<void>) => typeof stub;
        setProps: (p: unknown) => typeof stub;
        updateValue: (v: unknown) => typeof stub;
        setCharacteristic: () => typeof stub;
    } = {
        value: undefined,
        props: undefined,
        onGet: (fn: () => unknown) => { stub.getter = fn; return stub; },
        onSet: (fn: (v: unknown) => void | Promise<void>) => { stub.setter = fn; return stub; },
        setProps: (p: unknown) => { stub.props = p; return stub; },
        updateValue: (v: unknown) => { stub.value = v; return stub; },
        setCharacteristic: () => stub,
    };
    return stub;
}

function makeServiceStub(name: string) {
    const characteristics: Record<string, ReturnType<typeof makeCharacteristicStub>> = {};
    const linked: string[] = [];
    const svc = {
        name: name,
        setPrimaryService: (_primary: boolean) => svc,
        addLinkedService: (other: { name: string }) => { linked.push(other.name); return svc; },
        getCharacteristic: (c: string) => {
            if (!characteristics[c]) characteristics[c] = makeCharacteristicStub();
            return characteristics[c];
        },
        setCharacteristic: (c: string, v: unknown) => {
            if (!characteristics[c]) characteristics[c] = makeCharacteristicStub();
            characteristics[c].value = v;
            return svc;
        },
        updateCharacteristic: (c: string, v: unknown) => {
            if (!characteristics[c]) characteristics[c] = makeCharacteristicStub();
            characteristics[c].value = v;
            return svc;
        },
        characteristics: characteristics,
        linked: linked,
    };
    return svc;
}

export function makeMockAccessory() {
    const services: Record<string, ReturnType<typeof makeServiceStub>> = {};
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    return {
        context: {} as Record<string, unknown>,
        getService: (svc: string) => services[svc] ?? null,
        addService: (svc: string, _displayName?: string, _subtype?: string) => {
            services[svc] = makeServiceStub(svc);
            return services[svc];
        },
        removeService: (svc: { name: string } | string) => {
            const key = typeof svc === 'string' ? svc : svc.name;
            delete services[key];
        },
        on: (event: string, cb: (...args: unknown[]) => void) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
        },
        removeAllListeners: (event?: string) => {
            if (event) delete listeners[event]; else Object.keys(listeners).forEach(k => delete listeners[k]);
        },
        emit: (event: string, ...args: unknown[]) => { (listeners[event] ?? []).forEach(cb => cb(...args)); },
        services: services,
        listeners: listeners,
    };
}

export function makeMockPlatform(acknowledgeCommands = true) {
    const Service = {
        AccessoryInformation: 'AccessoryInformation',
        Lightbulb: 'Lightbulb',
        WindowCovering: 'WindowCovering',
        Thermostat: 'Thermostat',
        Switch: 'Switch',
        ContactSensor: 'ContactSensor',
        LightSensor: 'LightSensor',
        TemperatureSensor: 'TemperatureSensor',
        MotionSensor: 'MotionSensor',
        OccupancySensor: 'OccupancySensor',
        LeakSensor: 'LeakSensor',
        SmokeSensor: 'SmokeSensor',
        CarbonMonoxideSensor: 'CarbonMonoxideSensor',
        StatelessProgrammableSwitch: 'StatelessProgrammableSwitch',
        Outlet: 'Outlet',
        LockMechanism: 'LockMechanism',
        Doorbell: 'Doorbell',
    };

    const Characteristic = {
        Manufacturer: 'Manufacturer',
        Model: 'Model',
        Name: 'Name',
        SerialNumber: 'SerialNumber',
        On: 'On',
        Brightness: 'Brightness',
        CurrentPosition: 'CurrentPosition',
        TargetPosition: 'TargetPosition',
        PositionState: Object.assign('PositionState', POSITION_STATE),
        HoldPosition: 'HoldPosition',
        CurrentHeatingCoolingState: Object.assign('CurrentHeatingCoolingState', HEATING_COOLING_CURRENT),
        TargetHeatingCoolingState: Object.assign('TargetHeatingCoolingState', HEATING_COOLING_TARGET),
        CurrentTemperature: 'CurrentTemperature',
        TargetTemperature: 'TargetTemperature',
        TemperatureDisplayUnits: Object.assign('TemperatureDisplayUnits', { CELSIUS: 0 }),
        ContactSensorState: Object.assign('ContactSensorState', CONTACT_STATE),
        CurrentAmbientLightLevel: 'CurrentAmbientLightLevel',
        StatusActive: 'StatusActive',
        StatusFault: Object.assign('StatusFault', { NO_FAULT: 0, GENERAL_FAULT: 1 }),
        ConfiguredName: 'ConfiguredName',
        FirmwareRevision: 'FirmwareRevision',
        HardwareRevision: 'HardwareRevision',
        OutletInUse: 'OutletInUse',
        MotionDetected: 'MotionDetected',
        OccupancyDetected: 'OccupancyDetected',
        LeakDetected: 'LeakDetected',
        SmokeDetected: 'SmokeDetected',
        CarbonMonoxideDetected: 'CarbonMonoxideDetected',
        LockCurrentState: Object.assign('LockCurrentState', { UNSECURED: 0, SECURED: 1, JAMMED: 2, UNKNOWN: 3 }),
        LockTargetState: Object.assign('LockTargetState', { UNSECURED: 0, SECURED: 1 }),
        ProgrammableSwitchEvent: Object.assign('ProgrammableSwitchEvent', { SINGLE_PRESS: 0 }),
    };

    const sendCommandSpy = makeSpy(true);
    const updateAccessorySpy = makeSpy(true);

    return {
        log: { info: noop, debug: noop, warn: noop, error: noop, success: noop } as unknown as import('homebridge').Logging,
        controller: {
            sendCommand: (params: CommandParams): boolean => {
                const queued = !!sendCommandSpy(params);
                if (queued && acknowledgeCommands && params.serialKey) { params.started?.(); params.done?.(PKT.ACK, 0); }
                return queued;
            },
            cancelQueued: (_key: string) => {},
            commandQueue: [] as unknown[], queueSize: () => 0,
        },
        Service: Service as unknown as OwnPlatformLike['Service'],
        Characteristic: Characteristic as unknown as OwnPlatformLike['Characteristic'],
        HapStatusError: function (this: { code: number }, code: number) { this.code = code; } as unknown as new (status: number) => Error,
        HAPStatus: {
            NOT_ALLOWED_IN_CURRENT_STATE: -70412,
            SERVICE_COMMUNICATION_FAILURE: -70402,
            RESOURCE_BUSY: -70403,
            OPERATION_TIMED_OUT: -70408,
        } as unknown as OwnPlatformLike['HAPStatus'],
        updateAccessory: updateAccessorySpy as unknown as (a: import('homebridge').PlatformAccessory) => void,
        sendCommandSpy: sendCommandSpy,
        updateAccessorySpy: updateAccessorySpy,
    };
}

/** Exercise the real command queue and parser without connecting to a gateway. */
export function makeMockClient(log: OwnPlatformLike['log'], connectImmediately = true) {
    const client = new OwnClient('127.0.0.1', 20000, '', log);
    const connections: OwnConnection[] = [];
    const sent: string[] = [];
    client.newConnection = mode => {
        const connection = new OwnConnection(client.host, client.port, client.password, mode, log);
        connection.connect = () => {
            connection.conn = new Socket();
            connection.state = STATE.CONNECTED;
            if (connectImmediately) connection.emit('connected');
        };
        connection.sendPacket = packet => { sent.push(packet); };
        connections.push(connection);
        return connection;
    };
    return { client, connections, sent };
}
