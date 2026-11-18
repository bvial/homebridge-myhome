import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Accessory, Characteristic, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { OwnEnergyAccessory, type OwnPlatformLike } from '../lib/OwnAccessory';
import { makeMockPlatform } from './helpers';

const EVE_CONSUMPTION_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

function createHandler(accessory: Accessory) {
    const platform = { ...makeMockPlatform(), Service, Characteristic };
    const handler = new OwnEnergyAccessory(
        platform as unknown as OwnPlatformLike,
        Object.assign(accessory, { context: {} }) as unknown as PlatformAccessory,
        { id: 1, name: 'Energy', asOutlet: true },
    );
    return { platform, handler };
}

function consumption(accessory: Accessory) {
    const characteristic = accessory.getService(Service.Outlet)?.characteristics.find(c => c.UUID === EVE_CONSUMPTION_UUID);
    assert.ok(characteristic, 'Outlet must expose the Eve Consumption characteristic');
    return characteristic;
}

describe('OwnEnergyAccessory with real HAP services', () => {
    it('updates Eve watts through the polling response without an API error', () => {
        const accessory = new Accessory('Energy', uuid.generate('energy-live-hap'));
        const { platform, handler } = createHandler(accessory);
        try {
            handler.updateStatus();
            const command = platform.sendCommandSpy.calls[0][0] as { packet: (packet: string) => void };
            assert.doesNotThrow(() => command.packet('*#18*1*113*250##'));
            assert.equal(consumption(accessory).value, 250);
            assert.equal(consumption(accessory).props.unit, 'W');
            assert.equal(accessory.getService(Service.Outlet)?.getCharacteristic(Characteristic.OutletInUse).value, true);
        } finally {
            handler.destroy();
        }
    });

    it('reuses the serialized Eve characteristic and continues updating after restart', () => {
        const accessory = new Accessory('Energy', uuid.generate('energy-restored-hap'));
        const original = createHandler(accessory);
        try {
            original.handler.onData('*#18*1*113*120##');
        } finally {
            original.handler.destroy();
        }
        const restoredAccessory = Accessory.deserialize(Accessory.serialize(accessory));
        const restoredCharacteristic = consumption(restoredAccessory);
        assert.equal(restoredCharacteristic.value, 120);
        const restored = createHandler(restoredAccessory);
        try {
            assert.equal(consumption(restoredAccessory), restoredCharacteristic);
            restored.handler.updateStatus();
            const command = restored.platform.sendCommandSpy.calls[0][0] as { packet: (packet: string) => void };
            command.packet('*#18*1*113*400##');
            assert.equal(consumption(restoredAccessory).value, 400);
            assert.equal(restoredAccessory.getService(Service.Outlet)?.characteristics.filter(c => c.UUID === EVE_CONSUMPTION_UUID).length, 1);
        } finally {
            restored.handler.destroy();
        }
    });
});
