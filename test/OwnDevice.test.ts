import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { PlatformAccessory } from 'homebridge';
import {
    OwnBlindAccessory, OwnContactAccessory, OwnDoorAccessory, OwnEnergyAccessory,
    OwnLightAccessory, OwnScenarioAccessory, OwnThermostatAccessory, type OwnPlatformLike,
} from '../lib/OwnAccessory';
import type { DeviceCommand, DeviceEvent, DeviceState } from '../lib/OwnDevice';
import { makeMockAccessory, makeMockPlatform, makeMockClient, HEATING_COOLING_TARGET } from './helpers';
import { PKT, type CommandParams } from '../lib/OwnNet';
import { COMMAND_TIMEOUT_MS } from '../lib/utils';

function setup() {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory();
    accessory.addService('AccessoryInformation');
    return { platform, accessory, api: platform as unknown as OwnPlatformLike, acc: accessory as unknown as PlatformAccessory };
}

function states(events: DeviceEvent[]): DeviceState[] {
    return events.filter((event): event is Extract<DeviceEvent, { type: 'state' }> => event.type === 'state')
        .map(event => event.state);
}

describe('Shared MyHome device interface', () => {
    it('uses the same light command path for HAP and other adapters, then reports bus changes', () => {
        const { platform, accessory, api, acc } = setup();
        const device = new OwnLightAccessory(api, acc, { id: 1, dimmer: true, where: '68#4#01' });
        const events: DeviceEvent[] = [];
        const commands: DeviceCommand[] = [];
        const execute = device.execute.bind(device);
        device.execute = command => { commands.push(command); return execute(command); };
        device.subscribe(event => events.push(event));
        try {
            accessory.services.Lightbulb.characteristics.On.setter!(true);
            device.execute({ type: 'brightness', value: 50 });
            assert.deepEqual(commands, [{ type: 'power', value: true }, { type: 'brightness', value: 50 }]);
            assert.equal(platform.sendCommandSpy.calls.length, 2, 'one bus command per user action');
            assert.equal(device.snapshot().brightness, 50);
            assert.equal(accessory.services.Lightbulb.characteristics.Brightness.value, 50);
            assert.equal(accessory.services.Lightbulb.characteristics.On.value, true);
            device.onData('*1*0*68#4#01##');
            assert.equal(states(events).pop()?.on, false);
            assert.equal(device.snapshot().on, false);
        } finally { device.destroy(); }
    });

    it('does not publish a successful state when the shared command is rejected', () => {
        const { platform, accessory, api, acc } = setup();
        const device = new OwnLightAccessory(api, acc, { id: 1 });
        const events: DeviceEvent[] = [];
        device.subscribe(event => events.push(event));
        platform.controller.queueSize = () => 50;
        const busy = (error: unknown) => (error as { code: number }).code === -70403;
        try {
            assert.throws(() => device.execute({ type: 'power', value: true }), busy);
            assert.throws(() => accessory.services.Lightbulb.characteristics.On.setter!(true), busy);
            assert.equal(device.snapshot().on, false);
            assert.equal(events.length, 0);
        } finally { device.destroy(); }
    });

    it('reports rename and availability changes, and releases subscribers on unsubscribe and destroy', () => {
        const { accessory, api, acc } = setup();
        const device = new OwnContactAccessory(api, acc, { id: 5 });
        const events: DeviceEvent[] = [];
        const unsubscribe = device.subscribe(event => events.push(event));
        accessory.services.ContactSensor.characteristics.ConfiguredName.setter!('Window');
        device.setOnline(false);
        assert.equal(states(events).pop()?.name, 'Window');
        assert.equal(states(events).pop()?.online, false);
        unsubscribe();
        const count = events.length;
        device.setOnline(true);
        assert.equal(events.length, count);
        device.subscribe(event => events.push(event));
        device.destroy();
        assert.equal(device.snapshot().online, false);
        device.onData('*9*1*5##');
        assert.equal(events.length, count);
        assert.throws(() => device.execute({ type: 'identify' }),
            (error: unknown) => (error as { code: number }).code === -70402);
    });

    it('continues delivering events if another subscriber throws', () => {
        const { api, acc } = setup();
        const device = new OwnLightAccessory(api, acc, { id: 1 });
        const events: DeviceEvent[] = [];
        device.subscribe(() => { throw new Error('subscriber failed'); });
        device.subscribe(event => events.push(event));
        try {
            assert.doesNotThrow(() => device.onData('*1*1*1##'));
            assert.equal(states(events).pop()?.on, true);
        } finally { device.destroy(); }
    });

    it('shares one blind position tracker and publishes timer progress and STOP', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        t.mock.method(performance, 'now', () => Date.now());
        const { platform, accessory, api, acc } = setup();
        accessory.context.blindPosition = 0;
        const device = new OwnBlindAccessory(api, acc, { id: 2, time: 20, calibrateOnStart: false });
        device.setOnline(true);
        const events: DeviceEvent[] = [];
        device.subscribe(event => events.push(event));
        try {
            await accessory.services.WindowCovering.characteristics.TargetPosition.setter!(80);
            assert.equal(platform.sendCommandSpy.calls.length, 1);
            device.onData('*2*1*2##');
            const firstPosition = device.snapshot().position!;
            t.mock.timers.tick(250);
            assert.equal(device.snapshot().position, firstPosition + 1);
            assert.equal(states(events).pop()?.moving, 'opening');
            assert.equal(states(events).pop()?.targetPosition, 80);
            await device.execute({ type: 'stop' });
            device.onData('*2*0*2##');
            assert.equal(device.snapshot().moving, 'stopped');
            assert.equal(device.snapshot().targetPosition, device.snapshot().position);
            assert.equal(accessory.services.WindowCovering.characteristics.TargetPosition.value, device.snapshot().position);
        } finally { device.destroy(); }
    });

    it('exposes MyHome programme mode distinctly and retains its temperature-write restriction', () => {
        const { accessory, api, acc } = setup();
        const device = new OwnThermostatAccessory(api, acc, { id: 3, zone: 1, matterMode: 'heat' });
        const events: DeviceEvent[] = [];
        device.subscribe(event => events.push(event));
        try {
            accessory.services.Thermostat.characteristics.TargetHeatingCoolingState.setter!(HEATING_COOLING_TARGET.HEAT);
            device.execute({ type: 'temperature', value: 22 });
            assert.equal(accessory.services.Thermostat.characteristics.TargetTemperature.value, 22);
            device.execute({ type: 'mode', value: 'auto' });
            device.onData('*#4*3*0*0210##');
            assert.equal(states(events).pop()?.mode, 'auto');
            assert.equal(states(events).pop()?.temperature, 21);
            assert.throws(() => device.execute({ type: 'temperature', value: 23 }),
                (error: unknown) => (error as { code: number }).code === -70412);
            assert.equal(device.snapshot().mode, 'auto');
            assert.equal(device.snapshot().targetTemperature, 22);
        } finally { device.destroy(); }
    });

    it('publishes a momentary scenario activation and its timed reset', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { api, acc } = setup();
        const device = new OwnScenarioAccessory(api, acc, { id: 4, where: '01' });
        const events: DeviceEvent[] = [];
        device.subscribe(event => events.push(event));
        try {
            device.execute({ type: 'activate' });
            assert.equal(states(events).pop()?.on, true);
            t.mock.timers.tick(500);
            assert.equal(states(events).pop()?.on, false);
        } finally { device.destroy(); }
    });

    it('publishes dry-contact and energy polling states in protocol-neutral units', () => {
        const contactFixture = setup();
        const energyFixture = setup();
        const contact = new OwnContactAccessory(contactFixture.api, contactFixture.acc, { id: 5, sensorType: 'co' });
        const energy = new OwnEnergyAccessory(energyFixture.api, energyFixture.acc, { id: 6 });
        const contactEvents: DeviceEvent[] = [];
        const energyEvents: DeviceEvent[] = [];
        contact.subscribe(event => contactEvents.push(event));
        energy.subscribe(event => energyEvents.push(event));
        try {
            contact.onData('*9*1*5##');
            assert.equal(states(contactEvents).pop()?.triggered, true);
            energy.updateStatus();
            const command = energyFixture.platform.sendCommandSpy.calls[0][0] as { packet: (packet: string) => void };
            command.packet('*#18*6*113*250##');
            assert.equal(states(energyEvents).pop()?.watts, 250);
        } finally { contact.destroy(); energy.destroy(); }
    });

    it('publishes door relay resets and repeated doorbell events without suppressing them', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { accessory, api, acc } = setup();
        const device = new OwnDoorAccessory(api, acc, { id: 7, doorbell: true });
        const events: DeviceEvent[] = [];
        device.subscribe(event => events.push(event));
        try {
            device.execute({ type: 'unlock' });
            assert.equal(device.snapshot().locked, false);
            assert.equal(accessory.services.LockMechanism.characteristics.LockCurrentState.value, 0);
            device.onData('*7*19*7##'); // Our own relay echo must not ring the bell.
            device.onData('*7*20*7##');
            device.onData('*7*20*7##');
            assert.equal(events.filter(event => event.type === 'doorbell').length, 2);
            t.mock.timers.tick(3000);
            assert.equal(states(events).pop()?.locked, true);
        } finally { device.destroy(); }
    });
});

describe('Shared commands await gateway acknowledgement', () => {
    for (const failure of ['nack', 'close', 'timeout', 'shutdown'] as const) {
        it(`propagates ${failure} to the HAP caller without reporting success`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const { platform, accessory, api, acc } = setup();
            const { client, connections } = makeMockClient(platform.log);
            api.controller = client;
            const light = new OwnLightAccessory(api, acc, { id: 1 });
            t.after(() => { light.destroy(); client.destroy(); });
            const events: DeviceEvent[] = [];
            light.subscribe(event => events.push(event));
            const result = accessory.services.Lightbulb.characteristics.On.setter!(true);
            assert.ok(result instanceof Promise, 'HAP must receive the pending command result');
            assert.equal(light.snapshot().on, false);
            const rejected = assert.rejects(result, (error: unknown) =>
                (error as { code: number }).code === (failure === 'timeout' ? -70408 : -70402));
            if (failure === 'nack') connections[0].onData(PKT.NACK);
            else if (failure === 'close') connections[0].end();
            else if (failure === 'timeout') t.mock.timers.tick(COMMAND_TIMEOUT_MS);
            else client.destroy();
            await rejected;
            assert.equal(light.snapshot().on, false);
            assert.equal(states(events).some(state => state.on), false);
        });
    }

    it('commits the state on ACK and keeps overlapping commands in order', async t => {
        const { platform, api, acc } = setup();
        const { client, connections, sent } = makeMockClient(platform.log);
        api.controller = client;
        const light = new OwnLightAccessory(api, acc, { id: 1 });
        t.after(() => { light.destroy(); client.destroy(); });
        const on = light.execute({ type: 'power', value: true });
        const off = light.execute({ type: 'power', value: false });
        assert.deepEqual(sent, ['*1*1*1##']);
        assert.equal(light.snapshot().on, false);
        connections[0].onData(PKT.ACK);
        await on;
        assert.equal(light.snapshot().on, true);
        assert.deepEqual(sent, ['*1*1*1##', '*1*0*1##']);
        connections[1].onData(PKT.ACK);
        await off;
        assert.equal(light.snapshot().on, false);
    });

    for (const kind of ['brightness', 'mode', 'temperature', 'activate', 'unlock'] as const) {
        it(`does not commit a rejected ${kind} action`, async t => {
            const { platform, accessory, api, acc } = setup();
            const { client, connections } = makeMockClient(platform.log);
            api.controller = client;
            const device = kind === 'brightness' ? new OwnLightAccessory(api, acc, { id: 1, dimmer: true })
                : kind === 'activate' ? new OwnScenarioAccessory(api, acc, { id: 1, where: '01' })
                    : kind === 'unlock' ? new OwnDoorAccessory(api, acc, { id: 1 })
                        : new OwnThermostatAccessory(api, acc, { id: 1, zone: 1 });
            t.after(() => { device.destroy(); client.destroy(); });
            if (device instanceof OwnThermostatAccessory) device.onData('*4*110#0200*#0#1##');
            const before = device.snapshot();
            const result = kind === 'brightness' ? accessory.services.Lightbulb.characteristics.Brightness.setter!(50)
                : kind === 'activate' ? accessory.services.Switch.characteristics.On.setter!(true)
                    : kind === 'unlock' ? accessory.services.LockMechanism.characteristics.LockTargetState.setter!(0)
                        : kind === 'mode' ? accessory.services.Thermostat.characteristics.TargetHeatingCoolingState.setter!(0)
                            : accessory.services.Thermostat.characteristics.TargetTemperature.setter!(23);
            assert.ok(result instanceof Promise);
            assert.deepEqual(device.snapshot(), before);
            const rejected = assert.rejects(result, (error: unknown) => (error as { code: number }).code === -70402);
            connections[0].onData(PKT.NACK);
            await rejected;
            assert.deepEqual(device.snapshot(), before);
        });
    }

    it('starts the momentary relay reset window on ACK, not when queued', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { platform, api, acc } = setup();
        const { client, connections } = makeMockClient(platform.log);
        api.controller = client;
        const door = new OwnDoorAccessory(api, acc, { id: 1 });
        t.after(() => { door.destroy(); client.destroy(); });
        const result = door.execute({ type: 'unlock' });
        t.mock.timers.tick(4000);
        assert.equal(door.snapshot().locked, true);
        connections[0].onData(PKT.ACK);
        await result;
        assert.equal(door.snapshot().locked, false);
        t.mock.timers.tick(2999);
        assert.equal(door.snapshot().locked, false);
        t.mock.timers.tick(1);
        assert.equal(door.snapshot().locked, true);
    });

    it('accepts simultaneous HAP mode and setpoint writes without reporting the mode before ACK', async t => {
        const { platform, accessory, api, acc } = setup();
        const { client, connections, sent } = makeMockClient(platform.log);
        api.controller = client;
        const thermostat = new OwnThermostatAccessory(api, acc, { id: 1, zone: 1 });
        t.after(() => { thermostat.destroy(); client.destroy(); });
        const chars = accessory.services.Thermostat.characteristics;
        const mode = chars.TargetHeatingCoolingState.setter!(HEATING_COOLING_TARGET.COOL);
        const temperature = chars.TargetTemperature.setter!(23);
        assert.equal(thermostat.snapshot().mode, 'off');
        assert.equal(thermostat.snapshot().targetTemperature, 20);
        assert.deepEqual(sent, ['*#4*#0#1*#14*0200*2##']);
        connections[0].onData(PKT.ACK);
        await mode;
        assert.equal(thermostat.snapshot().mode, 'cool');
        assert.deepEqual(sent, ['*#4*#0#1*#14*0200*2##', '*#4*#0#1*#14*0230*2##']);
        connections[1].onData(PKT.ACK);
        await temperature;
        assert.equal(thermostat.snapshot().targetTemperature, 23);
    });

    it('blocks temperature writes behind pending AUTO and clears a rejected manual-mode intent', async t => {
        const { platform, api, acc } = setup();
        const { client, connections } = makeMockClient(platform.log);
        api.controller = client;
        const thermostat = new OwnThermostatAccessory(api, acc, { id: 1, zone: 1 });
        t.after(() => { thermostat.destroy(); client.destroy(); });
        thermostat.onData('*4*110#0200*#0#1##');
        const auto = thermostat.execute({ type: 'mode', value: 'auto' });
        assert.throws(() => thermostat.execute({ type: 'temperature', value: 23 }),
            (error: unknown) => (error as { code: number }).code === -70412);
        connections[0].onData(PKT.ACK);
        await auto;
        const manual = thermostat.execute({ type: 'mode', value: 'heat' });
        const rejected = assert.rejects(Promise.resolve(manual));
        connections[1].onData(PKT.NACK);
        await rejected;
        assert.equal(thermostat.snapshot().mode, 'auto');
        assert.throws(() => thermostat.execute({ type: 'temperature', value: 23 }),
            (error: unknown) => (error as { code: number }).code === -70412);
    });

    it('reflects a successful manual setpoint even when the preceding mode command was rejected', async t => {
        const { platform, api, acc } = setup();
        const { client, connections } = makeMockClient(platform.log);
        api.controller = client;
        const thermostat = new OwnThermostatAccessory(api, acc, { id: 1, zone: 1 });
        t.after(() => { thermostat.destroy(); client.destroy(); });
        const mode = thermostat.execute({ type: 'mode', value: 'cool' });
        const rejected = assert.rejects(Promise.resolve(mode));
        const temperature = thermostat.execute({ type: 'temperature', value: 23 });
        connections[0].onData(PKT.NACK);
        await rejected;
        assert.equal(thermostat.snapshot().mode, 'off');
        connections[1].onData(PKT.ACK);
        await temperature;
        assert.equal(thermostat.snapshot().mode, 'cool');
        assert.equal(thermostat.snapshot().targetTemperature, 23);
    });

    it('rejects a late ACK after the accessory is destroyed without starting timers', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { platform, api, acc } = setup();
        const { client, connections } = makeMockClient(platform.log);
        api.controller = client;
        const door = new OwnDoorAccessory(api, acc, { id: 1 });
        t.after(() => client.destroy());
        const result = door.execute({ type: 'unlock' });
        const rejected = assert.rejects(Promise.resolve(result), (error: unknown) => (error as { code: number }).code === -70402);
        door.destroy();
        connections[0].onData(PKT.ACK);
        await rejected;
        t.mock.timers.tick(5000);
        assert.equal(door.snapshot().locked, true);
    });
});

describe('Blind pending commands', () => {
    for (const direction of ['up', 'down'] as const) {
        it(`sends STOP after a delayed ${direction} even before its first monitor echo`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const { platform, accessory, api, acc } = setup();
            accessory.context.blindPosition = 50;
            const { client, connections, sent } = makeMockClient(platform.log, false);
            api.controller = client;
            const blind = new OwnBlindAccessory(api, acc, { id: 2, time: 20, calibrateOnStart: false });
            blind.setOnline(true);
            t.after(() => { blind.destroy(); client.destroy(); });
            const move = blind.execute({ type: 'position', value: direction === 'up' ? 80 : 20 });
            const cancelled = assert.rejects(Promise.resolve(move), (err: unknown) => (err as { code: number }).code === -70412);
            const stop = blind.execute({ type: 'stop' });
            assert.equal(connections.length, 1, 'STOP must not race the UP/DOWN TCP handshake');
            assert.deepEqual(sent, []);
            connections[0].emit('connected');
            await cancelled;
            assert.deepEqual(sent, [], 'a superseded handshake must not send its movement');
            connections[1].emit('connected');
            assert.deepEqual(sent, ['*2*0*2##']);
            blind.onData('*2*0*2##');
            connections[1].onData(PKT.ACK);
            await stop;
            t.mock.timers.tick(5000);
            assert.equal(blind.snapshot().moving, 'stopped');
            assert.equal(blind.snapshot().position, blind.snapshot().targetPosition);
            assert.equal(sent.length, 1, 'late timers must not restart movement');
        });
    }

    it('does not force motion or retain a target after a command times out', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { platform, api, acc } = setup();
        const { client } = makeMockClient(platform.log);
        api.controller = client;
        acc.context.blindPosition = 0;
        const blind = new OwnBlindAccessory(api, acc, { id: 2, time: 20, calibrateOnStart: false });
        blind.setOnline(true);
        t.after(() => { blind.destroy(); client.destroy(); });
        const result = blind.execute({ type: 'position', value: 80 });
        const rejected = assert.rejects(Promise.resolve(result), (error: unknown) => (error as { code: number }).code === -70408);
        t.mock.timers.tick(COMMAND_TIMEOUT_MS);
        await rejected;
        assert.equal(blind.snapshot().moving, 'stopped');
        assert.equal(blind.snapshot().targetPosition, 0);
        assert.equal(blind.snapshot().blindPhase, 'fault');
    });

    it('does not let a failed superseded move cancel a pending STOP', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { platform, api, acc } = setup();
        acc.context.blindPosition = 0;
        platform.controller.sendCommand = (params: CommandParams) => { platform.sendCommandSpy(params); return true; };
        const blind = new OwnBlindAccessory(api, acc, { id: 2, time: 20, calibrateOnStart: false });
        blind.setOnline(true);
        t.after(() => blind.destroy());
        const move = blind.execute({ type: 'position', value: 80 });
        const rejected = assert.rejects(Promise.resolve(move));
        const stop = blind.execute({ type: 'stop' });
        const [up, halt] = platform.sendCommandSpy.calls.map(([params]) => params as CommandParams);
        up.done!(null, -1);
        await rejected;
        assert.equal(blind.snapshot().blindPhase, 'stopping');
        halt.done!(PKT.ACK, 0);
        await stop;
        blind.onData('*2*0*2##');
        assert.equal(blind.snapshot().moving, 'stopped');
    });
});
