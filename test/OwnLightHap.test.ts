import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Accessory, Characteristic, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { OwnLightAccessory, type OwnPlatformLike } from '../lib/OwnAccessory';
import { makeMockClient, makeMockPlatform } from './helpers';
import { PKT } from '../lib/OwnNet';

function fixture(t: TestContext) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const mock = makeMockPlatform();
    const network = makeMockClient(mock.log);
    const platform = { ...mock, Service, Characteristic, HapStatusError, controller: network.client };
    const accessory = Object.assign(new Accessory('Dimmer', uuid.generate(t.name)), { context: {} });
    const device = new OwnLightAccessory(platform as unknown as OwnPlatformLike, accessory as unknown as PlatformAccessory, { id: 1, dimmer: true });
    t.after(() => { device.destroy(); network.client.destroy(); });
    const service = accessory.getService(Service.Lightbulb)!;
    return { ...network, device, brightness: service.getCharacteristic(Characteristic.Brightness), power: service.getCharacteristic(Characteristic.On) };
}

describe('Light acknowledgement and HAP state', () => {
    for (const { report, expected } of [
        { report: undefined, expected: 60 },
        { report: '*1*7*1##', expected: 70 },
        { report: '*1*1*1##', expected: 60 },
        { report: '*1*4*1##', expected: 40 },
        { report: '*#1*1*1*163*0##', expected: 63 },
        { report: '*99*invalid##', expected: 60 },
    ]) {
        it(`reports the actual level after HAP writes 60%, bus report=${report ?? 'none'}`, async t => {
            const f = fixture(t);
            const writing = f.brightness.handleSetRequest(60);
            assert.deepEqual(f.sent, ['*1*6*1##']);
            if (report) f.device.onData(report);
            f.connections[0].onData(PKT.ACK); await writing;
            t.mock.timers.tick(0); // HAP has committed its request; publish the actual level
            assert.equal(f.device.snapshot().brightness, expected);
            assert.equal(f.brightness.value, expected);
            assert.equal(await f.brightness.handleGetRequest(), expected);
        });
    }

    for (const kind of ['power', 'brightness'] as const) {
        it(`preserves a wall OFF reported before the ${kind} ACK`, async t => {
            const f = fixture(t);
            const writing = kind === 'power' ? f.power.handleSetRequest(true) : f.brightness.handleSetRequest(60);
            f.device.onData('*1*0*1##');
            f.connections[0].onData(PKT.ACK); await writing;
            t.mock.timers.tick(0);
            assert.equal(f.device.snapshot().on, false);
            assert.equal(f.power.value, false);
            assert.equal(await f.power.handleGetRequest(), false);
        });
    }

    it('captures the bus baseline at dispatch, not when a later write is queued', async t => {
        const f = fixture(t);
        const first = f.device.execute({ type: 'brightness', value: 60 });
        const second = f.device.execute({ type: 'brightness', value: 40 });
        f.device.onData('*1*7*1##');
        f.connections[0].onData(PKT.ACK); await first;
        assert.equal(f.device.snapshot().brightness, 70);
        f.connections[1].onData(PKT.ACK); await second;
        assert.equal(f.device.snapshot().brightness, 40);
        assert.deepEqual(f.sent, ['*1*6*1##', '*1*4*1##']);
    });

    it('keeps a later bus event when a deferred HAP correction runs', async t => {
        const f = fixture(t);
        const writing = f.brightness.handleSetRequest(60);
        f.connections[0].onData(PKT.ACK); await writing;
        f.device.onData('*1*4*1##');
        t.mock.timers.tick(0);
        assert.equal(f.brightness.value, 40);
        assert.equal(f.device.snapshot().brightness, 40);
    });
});
