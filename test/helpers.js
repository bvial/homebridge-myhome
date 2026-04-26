'use strict';

const POSITION_STATE = { DECREASING: 0, INCREASING: 1, STOPPED: 2 };
const HEATING_COOLING_CURRENT = { OFF: 0, HEAT: 1, COOL: 2 };
const HEATING_COOLING_TARGET = { OFF: 0, HEAT: 1, AUTO: 3 };
const CONTACT_STATE = { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 };
const TEMP_UNITS = { CELSIUS: 0 };

function noop() {}

function makeSpy() {
    var calls = [];
    var fn = function () { calls.push(Array.from(arguments)); };
    fn.calls = calls;
    return fn;
}

function makeCharacteristicStub() {
    var stub = {
        _value: undefined,
        _props: undefined,
        onGet: function (fn) { stub._getter = fn; return stub; },
        onSet: function (fn) { stub._setter = fn; return stub; },
        setProps: function (p) { stub._props = p; return stub; },
        updateValue: function (v) { stub._value = v; return stub; },
        setCharacteristic: function () { return stub; },
    };
    return stub;
}

function makeServiceStub(name) {
    var characteristics = {};
    return {
        name: name,
        getCharacteristic: function (c) {
            if (!characteristics[c]) characteristics[c] = makeCharacteristicStub();
            return characteristics[c];
        },
        setCharacteristic: function (c, v) {
            if (!characteristics[c]) characteristics[c] = makeCharacteristicStub();
            characteristics[c]._value = v;
            return this;
        },
        _characteristics: characteristics,
    };
}

function makeMockAccessory() {
    var services = {};
    return {
        context: {},
        getService: function (svc) { return services[svc] || null; },
        addService: function (svc) {
            services[svc] = makeServiceStub(svc);
            return services[svc];
        },
        _services: services,
    };
}

function makeMockPlatform() {
    var Service = {
        AccessoryInformation: 'AccessoryInformation',
        Lightbulb: 'Lightbulb',
        WindowCovering: 'WindowCovering',
        Thermostat: 'Thermostat',
        Switch: 'Switch',
        ContactSensor: 'ContactSensor',
        LightSensor: 'LightSensor',
    };

    var Characteristic = {
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
        HapStatusError: function (code) { this.code = code; },
    };

    var sendCommandSpy = makeSpy();

    return {
        log: { info: noop, debug: noop, warn: noop, error: noop },
        controller: { sendCommand: sendCommandSpy },
        Service: Service,
        Characteristic: Characteristic,
        _sendCommandSpy: sendCommandSpy,
    };
}

module.exports = {
    makeMockPlatform,
    makeMockAccessory,
    makeSpy,
    POSITION_STATE,
    HEATING_COOLING_CURRENT,
    HEATING_COOLING_TARGET,
    CONTACT_STATE,
};
