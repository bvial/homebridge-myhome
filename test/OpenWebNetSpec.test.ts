import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformAccessory } from 'homebridge';
import { OwnProtcol } from '../lib/OwnProtcol';
import { brightnessToOwnLevel, ownLevelToBrightness } from '../lib/utils';
import { OwnContactAccessory, OwnEnergyAccessory, OwnScenarioAccessory, OwnThermostatAccessory, type OwnPlatformLike } from '../lib/OwnAccessory';
import { makeMockAccessory, makeMockPlatform } from './helpers';
import { runStatusScan } from '../lib/scanHelper';
import { PKT, type CommandParams, type OwnClient } from '../lib/OwnNet';

function fixture() {
    const platform = makeMockPlatform();
    const accessory = makeMockAccessory(); accessory.addService('AccessoryInformation');
    return { platform, accessory, p: platform as unknown as OwnPlatformLike, a: accessory as unknown as PlatformAccessory };
}

describe('OpenWebNet official wire examples', () => {
    for (let what = 2; what <= 10; what++) {
        it(`WHO 1 WHAT ${what} is ${what * 10}%`, () => {
            assert.equal(ownLevelToBrightness(what), what * 10);
            assert.equal(brightnessToOwnLevel(what * 10), what);
            assert.deepEqual(OwnProtcol.decodeLightState(`*1*${what}*11##`), { where: '11', on: true, brightness: what * 10 });
        });
    }
    it('decodes DIM 1 on the 100..200 scale, and does not treat timed commands as dimmer levels', () => {
        assert.equal(brightnessToOwnLevel(1), 2);
        assert.equal(brightnessToOwnLevel(64), 6);
        assert.deepEqual(OwnProtcol.decodeLightState('*#1*68#4#01*1*163*255##'), { where: '68#4#01', on: true, brightness: 63 });
        assert.deepEqual(OwnProtcol.decodeLightState('*#1*11*1*100*0##'), { where: '11', on: false, brightness: 0 });
        assert.deepEqual(OwnProtcol.decodeLightState('*1*1000#11*11##'), { where: '11', on: true });
        assert.equal(OwnProtcol.decodeLightState('*1*30*11##'), null);
        assert.equal(OwnProtcol.decodeLightState('*#1*11*1*201*0##'), null);
    });
    it('extracts WHERE by field position, including video frames with a trailing parameter', () => {
        assert.deepEqual(OwnProtcol.extractPacketInfo('*7*0*4001*##'), { who: 7, where: '4001' });
        assert.deepEqual(OwnProtcol.extractPacketInfo('*#18*71#0*113*500##'), { who: 18, where: '71#0' });
        assert.deepEqual(OwnProtcol.extractPacketInfo('*#4*#1##'), { who: 4, where: '#1' });
    });
    it('decodes advanced shutter position, unknown position and actuator refusal', () => {
        assert.deepEqual(OwnProtcol.decodeBlindReport('*#2*11*10*12*43*0*0##'), { where: '11', direction: 'closing', position: 43, disabled: false, rejected: false });
        assert.equal(OwnProtcol.decodeBlindReport('*#2*11*10*10*255*0*0##')?.position, null);
        assert.deepEqual(OwnProtcol.decodeBlindReport('*#2*11*10*10*43*0*14##'), { where: '11', direction: 'stopped', position: 43, disabled: false, rejected: true });
        for (const info of [12, 13]) assert.equal(OwnProtcol.decodeBlindReport(`*#2*11*10*10*43*0*${info}##`)?.disabled, true);
        assert.equal(OwnProtcol.decodeBlindReport('*2*1000#11#0#0*11##')?.direction, 'opening');
    });
    it('addresses a WHO 0 scenario module rather than the unsupported general address', async () => {
        const f = fixture();
        const device = new OwnScenarioAccessory(f.p, f.a, { id: 101, scenario: 3, where: '23' });
        try {
            await device.execute({ type: 'activate' });
            assert.equal((f.platform.sendCommandSpy.calls[0][0] as CommandParams).command, '*0*3*23##');
        } finally { device.destroy(); }
    });
    it('refuses an unaddressed scenario without sending a bus command', () => {
        const f = fixture();
        const device = new OwnScenarioAccessory(f.p, f.a, { id: 1 });
        assert.throws(() => device.execute({ type: 'activate' }));
        assert.equal(f.platform.sendCommandSpy.calls.length, 0);
        device.destroy();
    });
    for (const protocol of ['dry-contact', 'ir'] as const) {
        it(`decodes WHO 25 ${protocol} status and event polarity`, () => {
            const f = fixture();
            const device = new OwnContactAccessory(f.p, f.a, { id: 1, protocol, sensorType: protocol === 'ir' ? 'motion' : 'contact' });
            try {
                device.updateStatus();
                assert.equal((f.platform.sendCommandSpy.calls[0][0] as CommandParams).command, '*#25*31##');
                device.onData('*25*31#1*31##');
                assert.equal(device.snapshot().triggered, protocol === 'ir');
                device.onData('*25*32#0*31##');
                assert.equal(device.snapshot().triggered, protocol !== 'ir');
            } finally { device.destroy(); }
        });
    }
    it('supports WHO 18 actuator addresses with #0 and preserves physical zero watts', () => {
        const f = fixture();
        const device = new OwnEnergyAccessory(f.p, f.a, { id: 1, where: '71#0' });
        try {
            device.updateStatus();
            assert.equal((f.platform.sendCommandSpy.calls[0][0] as CommandParams).command, '*#18*71#0*113##');
            device.onData('*#18*71#0*113*500##'); assert.equal(device.snapshot().watts, 500);
            device.onData('*#18*71#0*113*0##'); assert.equal(device.snapshot().watts, 0);
        } finally { device.destroy(); }
    });
    it('uses 99-zone AUTO and generic OFF commands and recognizes cooling programmes and fan-coil activity', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const f = fixture();
        const device = new OwnThermostatAccessory(f.p, f.a, { id: 1, zone: 1, where: '#1' });
        try {
            await device.execute({ type: 'mode', value: 'auto' });
            await device.execute({ type: 'mode', value: 'off' });
            assert.deepEqual(f.platform.sendCommandSpy.calls.map(([params]) => (params as CommandParams).command), ['*4*311*#1##', '*4*303*#1##']);
            t.mock.timers.tick(1001); // subsequent central action, outside the own-echo window
            device.onData('*4*211*#1##'); assert.equal(device.snapshot().mode, 'auto');
            device.onData('*#4*1*19*6*0##'); assert.equal(device.snapshot().activeMode, 'cool');
            device.onData('*#4*1*19*5*0##'); assert.equal(device.snapshot().activeMode, 'off');
            device.onData('*4*1*1##'); assert.equal(device.snapshot().activeMode, 'off', 'season is not valve activity');
        } finally { device.destroy(); }
    });
    it('discovers only matching replies and probes the documented energy/contact addresses', async () => {
        const commands: string[] = [];
        const client = { sendCommand: (params: CommandParams) => {
            commands.push(params.command);
            if (params.command === '*#18*51*113##') params.packet?.('*#18*51*113*200##');
            else if (params.command === '*#25*31##') params.packet?.('*25*31#0*31##');
            else if (params.command === '*#1*1##') params.packet?.('*1*1*99##'); // unrelated reply
            params.done?.(PKT.ACK, 0);
            return true;
        } };
        const found = await runStatusScan(client as OwnClient, 1);
        assert.deepEqual(found.map(({ who, where }) => [who, where]), [[18, '51'], [25, '31']]);
        assert.ok(commands.includes('*#18*51*113##'));
        await assert.rejects(runStatusScan(client as OwnClient, Infinity));
    });
});
