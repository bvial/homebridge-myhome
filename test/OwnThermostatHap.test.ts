import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Accessory, Characteristic, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { OwnThermostatAccessory, type OwnPlatformLike } from '../lib/OwnAccessory';
import { makeMockClient, makeMockPlatform } from './helpers';
import { PKT } from '../lib/OwnNet';

function fixture(t: TestContext, connectImmediately = true) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const mock = makeMockPlatform();
    const network = makeMockClient(mock.log, connectImmediately);
    const platform = { ...mock, Service, Characteristic, HapStatusError, controller: network.client };
    const accessory = Object.assign(new Accessory('Thermostat', uuid.generate(t.name)), { context: {} });
    const device = new OwnThermostatAccessory(platform as unknown as OwnPlatformLike, accessory as unknown as PlatformAccessory, { id: 1, zone: 1 });
    t.after(() => { device.destroy(); network.client.destroy(); });
    const service = accessory.getService(Service.Thermostat)!;
    return { ...network, device,
        mode: service.getCharacteristic(Characteristic.TargetHeatingCoolingState),
        temperature: service.getCharacteristic(Characteristic.TargetTemperature),
    };
}

describe('Thermostat bus precedence and cancellation', () => {
    for (const mode of ['auto', 'off'] as const) {
        it(`preserves central ${mode} before a late mode ACK, including HAP reads and notifications`, async t => {
            const f = fixture(t);
            const writing = f.mode.handleSetRequest(Characteristic.TargetHeatingCoolingState.COOL);
            f.device.onData('*4*210#0200*#0#1##');
            f.device.onData(`*4*${mode === 'auto' ? 1101 : 103}*#0#1##`);
            assert.equal(f.device.snapshot().mode, mode);
            assert.throws(() => f.device.execute({ type: 'temperature', value: 23 }),
                (err: unknown) => err instanceof HapStatusError && Number(err.hapStatus) === -70412);
            f.connections[0].onData(PKT.ACK); await writing;
            t.mock.timers.tick(0);
            assert.equal(f.device.snapshot().mode, mode);
            const value = mode === 'auto' ? Characteristic.TargetHeatingCoolingState.AUTO : Characteristic.TargetHeatingCoolingState.OFF;
            assert.equal(f.mode.value, value);
            assert.equal(await f.mode.handleGetRequest(), value);
        });
    }

    it('cancels queued manual setpoints on central AUTO and accepts a subsequent explicit user choice', async t => {
        const f = fixture(t);
        const mode = f.device.execute({ type: 'mode', value: 'cool' });
        const temperature = f.temperature.handleSetRequest(23);
        const cancelled = assert.rejects(temperature, (err: unknown) => err === -70412);
        f.device.onData('*4*210#0200*#0#1##');
        f.device.onData('*4*1101*#0#1##');
        await cancelled;
        assert.equal(f.client.queueSize(), 0);
        f.connections[0].onData(PKT.ACK); await mode;
        assert.equal(f.device.snapshot().mode, 'auto');
        assert.deepEqual(f.sent, ['*#4*#0#1*#14*0200*2##']);
        const manual = f.mode.handleSetRequest(Characteristic.TargetHeatingCoolingState.HEAT);
        f.connections[1].onData(PKT.ACK); await manual;
        assert.equal(f.device.snapshot().mode, 'heat');
        const next = f.temperature.handleSetRequest(22);
        f.connections[2].onData(PKT.ACK); await next;
        assert.equal(f.device.snapshot().targetTemperature, 22);
    });

    it('cancels a manual-mode handshake before its packet can be sent', async t => {
        const f = fixture(t, false);
        const writing = f.mode.handleSetRequest(Characteristic.TargetHeatingCoolingState.COOL);
        const cancelled = assert.rejects(writing, (err: unknown) => err === -70412);
        f.device.onData('*4*1101*#0#1##');
        await cancelled;
        f.connections[0].emit('connected');
        assert.deepEqual(f.sent, []);
        assert.equal(f.device.snapshot().mode, 'auto');
    });

    it('preserves a newer DIM14 setpoint without treating it as a mode change', async t => {
        const f = fixture(t);
        f.device.onData('*4*110#0200*#0#1##');
        const writing = f.temperature.handleSetRequest(23);
        f.device.onData('*#4*1*14*0215*3##');
        f.connections[0].onData(PKT.ACK); await writing;
        t.mock.timers.tick(0);
        assert.equal(f.device.snapshot().mode, 'heat');
        assert.equal(f.device.snapshot().targetTemperature, 21.5);
        assert.equal(f.temperature.value, 21.5);
    });

    it('preserves a newer manual mode and setpoint before an earlier temperature ACK', async t => {
        const f = fixture(t);
        f.device.onData('*4*110#0200*#0#1##');
        const writing = f.temperature.handleSetRequest(23);
        f.device.onData('*4*210#0240*#0#1##');
        f.connections[0].onData(PKT.ACK); await writing;
        t.mock.timers.tick(0);
        assert.equal(f.device.snapshot().mode, 'cool');
        assert.equal(f.device.snapshot().targetTemperature, 24);
        assert.equal(f.mode.value, Characteristic.TargetHeatingCoolingState.COOL);
        assert.equal(f.temperature.value, 24);
    });

    for (const late of [false, true]) {
        it(`own ${late ? 'delayed' : 'prompt'} AUTO echoes do not cancel a newer queued manual choice`, async t => {
            const f = fixture(t);
            f.device.onData('*4*110#0200*#0#1##');
            const auto = f.device.execute({ type: 'mode', value: 'auto' });
            const cool = f.device.execute({ type: 'mode', value: 'cool' });
            const temperature = f.device.execute({ type: 'temperature', value: 23 });
            if (!late) f.device.onData('*4*1101*#0#1##');
            f.connections[0].onData(PKT.ACK); await auto;
            f.device.onData('*4*210#0200*#0#1##');
            f.connections[1].onData(PKT.ACK); await cool;
            if (late) f.device.onData('*4*1101*#0#1##');
            f.device.onData('*4*210#0230*#0#1##');
            f.connections[2].onData(PKT.ACK); await temperature;
            assert.equal(f.device.snapshot().mode, 'cool');
            assert.equal(f.device.snapshot().targetTemperature, 23);
            assert.deepEqual(f.sent, ['*4*3100*#0#1##', '*#4*#0#1*#14*0200*2##', '*#4*#0#1*#14*0230*2##']);
        });
    }

    it('ignores old query responses once a newer user write has been queued', async t => {
        const f = fixture(t);
        f.device.updateStatus();
        const writing = f.mode.handleSetRequest(Characteristic.TargetHeatingCoolingState.COOL);
        f.connections[0].onData('*4*1101*#0#1##');
        f.connections[0].onData(PKT.ACK);
        f.connections[1].onData(PKT.ACK);
        f.connections[2].onData(PKT.ACK); await writing;
        assert.equal(f.device.snapshot().mode, 'cool');
        assert.equal(f.sent.length, 3);
    });
});
