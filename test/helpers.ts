import type { OwnPlatformLike } from '../lib/OwnAccessory';

export const POSITION_STATE = { DECREASING: 0, INCREASING: 1, STOPPED: 2 } as const;
export const HEATING_COOLING_CURRENT = { OFF: 0, HEAT: 1, COOL: 2 } as const;
export const HEATING_COOLING_TARGET = { OFF: 0, HEAT: 1, AUTO: 3 } as const;
export const CONTACT_STATE = { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 } as const;
const TEMP_UNITS = { CELSIUS: 0 } as const;

function noop(): void {}

export interface Spy {
    (...args: unknown[]): void;
    calls: unknown[][];
}

export function makeSpy(): Spy {
    const calls: unknown[][] = [];
    const fn = function (...args: unknown[]) { calls.push(args); } as Spy;
    fn.calls = calls;
    return fn;
}

function makeCharacteristicStub() {
    const stub: Record<string, unknown> & {
        value: unknown;
        props: unknown;
        getter?: () => unknown;
        setter?: (v: unknown) => void;
        onGet: (fn: () => unknown) => typeof stub;
        onSet: (fn: (v: unknown) => void) => typeof stub;
        setProps: (p: unknown) => typeof stub;
        updateValue: (v: unknown) => typeof stub;
        setCharacteristic: () => typeof stub;
    } = {
        value: undefined,
        props: undefined,
        onGet: (fn: () => unknown) => { stub.getter = fn; return stub; },
        onSet: (fn: (v: unknown) => void) => { stub.setter = fn; return stub; },
        setProps: (p: unknown) => { stub.props = p; return stub; },
        updateValue: (v: unknown) => { stub.value = v; return stub; },
        setCharacteristic: () => stub,
    };
    return stub;
}

function makeServiceStub(name: string) {
    const characteristics: Record<string, ReturnType<typeof makeCharacteristicStub>> = {};
    const svc = {
        name: name,
        getCharacteristic: (c: string) => {
            if (!characteristics[c]) characteristics[c] = makeCharacteristicStub();
            return characteristics[c];
        },
        setCharacteristic: (c: string, v: unknown) => {
            if (!characteristics[c]) characteristics[c] = makeCharacteristicStub();
            characteristics[c].value = v;
            return svc;
        },
        characteristics: characteristics,
    };
    return svc;
}

export function makeMockAccessory() {
    const services: Record<string, ReturnType<typeof makeServiceStub>> = {};
    return {
        context: {} as Record<string, unknown>,
        getService: (svc: string) => services[svc] ?? null,
        addService: (svc: string) => {
            services[svc] = makeServiceStub(svc);
            return services[svc];
        },
        services: services,
    };
}

export function makeMockPlatform() {
    const Service = {
        AccessoryInformation: 'AccessoryInformation',
        Lightbulb: 'Lightbulb',
        WindowCovering: 'WindowCovering',
        Thermostat: 'Thermostat',
        Switch: 'Switch',
        ContactSensor: 'ContactSensor',
        LightSensor: 'LightSensor',
    };

    const Characteristic = {
        Manufacturer: 'Manufacturer',
        Model: 'Model',
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
        TemperatureDisplayUnits: Object.assign('TemperatureDisplayUnits', TEMP_UNITS),
        ContactSensorState: Object.assign('ContactSensorState', CONTACT_STATE),
        CurrentAmbientLightLevel: 'CurrentAmbientLightLevel',
    };

    const sendCommandSpy = makeSpy();

    return {
        log: { info: noop, debug: noop, warn: noop, error: noop } as unknown as import('homebridge').Logging,
        controller: { sendCommand: sendCommandSpy, commandQueue: [] as unknown[], queueSize: () => 0 },
        Service: Service as unknown as OwnPlatformLike['Service'],
        Characteristic: Characteristic as unknown as OwnPlatformLike['Characteristic'],
        HapStatusError: function (this: { code: number }, code: number) { this.code = code; } as unknown as new (status: number) => Error,
        sendCommandSpy: sendCommandSpy,
    };
}
