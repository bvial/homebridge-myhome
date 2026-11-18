import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Accessory, Characteristic, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { OwnBlindAccessory, type OwnPlatformLike } from '../lib/OwnAccessory';
import { makeMockClient, makeMockPlatform } from './helpers';
import { PKT } from '../lib/OwnNet';

describe('Blind HAP adapter', () => {
    it('returns gateway errors and persists fractional position and confidence on a wall STOP', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        t.mock.method(performance, 'now', () => Date.now());
        const mock = makeMockPlatform();
        const network = makeMockClient(mock.log);
        const platform = { ...mock, Service, Characteristic, HapStatusError, controller: network.client };
        const accessory = Object.assign(new Accessory('Blind', uuid.generate('blind-hap')), { context: { blindPosition: 50 } as Record<string, unknown> });
        const handler = new OwnBlindAccessory(platform as unknown as OwnPlatformLike, accessory as unknown as PlatformAccessory,
            { id: 2, time: 20, calibrateOnStart: false });
        t.after(() => { handler.destroy(); network.client.destroy(); });
        handler.setOnline(true);
        const covering = accessory.getService(Service.WindowCovering)!;
        const set = covering.getCharacteristic(Characteristic.TargetPosition).handleSetRequest(80);
        network.connections[0].onData(PKT.ACK); await set;
        t.mock.timers.tick(125);
        mock.updateAccessorySpy.calls.length = 0;
        handler.onData('*2*0*2##');
        assert.equal(handler.snapshot().position, 51);
        assert.equal(covering.getCharacteristic(Characteristic.CurrentPosition).value, 51);
        assert.equal((accessory.context.blindState as { position: number }).position, 50.625);
        assert.equal((accessory.context.blindState as { wasMoving: boolean }).wasMoving, false);
        assert.equal(mock.updateAccessorySpy.calls.length, 1);
        const failure = covering.getCharacteristic(Characteristic.TargetPosition).handleSetRequest(20);
        const rejected = assert.rejects(failure, (err: unknown) => err === -70402);
        network.connections[1].onData(PKT.NACK); await rejected;
        assert.equal(covering.getCharacteristic(Characteristic.StatusFault).value, 1);
        assert.equal(await covering.getCharacteristic(Characteristic.StatusFault).handleGetRequest(), 1);
    });

    it('keeps fault reads consistent with notifications through unknown, calibrated and offline states', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        t.mock.method(performance, 'now', () => Date.now());
        const platform = { ...makeMockPlatform(), Service, Characteristic, HapStatusError };
        const accessory = Object.assign(new Accessory('Blind', uuid.generate('blind-hap-fault')), { context: {} });
        const handler = new OwnBlindAccessory(platform as unknown as OwnPlatformLike, accessory as unknown as PlatformAccessory,
            { id: 2, time: 20, calibration: 'manual' });
        t.after(() => handler.destroy());
        handler.setOnline(true);
        const fault = accessory.getService(Service.WindowCovering)!.getCharacteristic(Characteristic.StatusFault);
        assert.equal(fault.value, 1);
        assert.equal(await fault.handleGetRequest(), 1);
        await handler.execute({ type: 'calibrate' });
        t.mock.timers.tick(21000);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        assert.equal(handler.snapshot().positionConfidence, 'calibrated');
        assert.equal(fault.value, 0);
        assert.equal(await fault.handleGetRequest(), 0);
        handler.setOnline(false);
        assert.equal(fault.value, 1);
        assert.equal(await fault.handleGetRequest(), 1);
        handler.setOnline(true);
        assert.equal(fault.value, 1);
        assert.equal(await fault.handleGetRequest(), 1, 'reconnection alone cannot restore position confidence');
    });

    it('exposes manual calibration and removes its linked control when disabled', async t => {
        const mock = makeMockPlatform();
        const platform = { ...mock, Service, Characteristic, HapStatusError };
        const accessory = Object.assign(new Accessory('Blind', uuid.generate('blind-calibration')), { context: {} });
        const handler = new OwnBlindAccessory(platform as unknown as OwnPlatformLike, accessory as unknown as PlatformAccessory,
            { id: 2, time: 20, calibration: 'manual' });
        handler.setOnline(true);
        const calibration = accessory.getService(Service.Switch)!;
        await calibration.getCharacteristic(Characteristic.On).handleSetRequest(true);
        assert.equal(handler.snapshot().calibrating, true);
        await calibration.getCharacteristic(Characteristic.On).handleSetRequest(false);
        assert.equal(handler.snapshot().calibrating, false);
        assert.equal(handler.snapshot().positionConfidence, 'unknown');
        handler.destroy();
        const restored = new OwnBlindAccessory(platform as unknown as OwnPlatformLike, accessory as unknown as PlatformAccessory,
            { id: 2, time: 20, calibrateOnStart: false });
        t.after(() => restored.destroy());
        assert.equal(accessory.getService(Service.Switch), undefined);
        assert.equal(accessory.getService(Service.WindowCovering)!.linkedServices.includes(calibration), false);
    });
});
