import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeMockPlatform, makeMockAccessory, HEATING_COOLING_CURRENT, HEATING_COOLING_TARGET, CONTACT_STATE } from './helpers';
import type { OwnPlatformLike } from '../lib/OwnAccessory';
import type { PlatformAccessory } from 'homebridge';
import {
    OwnLightAccessory,
    OwnThermostatAccessory,
    OwnScenarioAccessory,
    OwnContactAccessory,
    OwnEnergyAccessory,
    OwnDoorAccessory,
} from '../lib/OwnAccessory';

type P = OwnPlatformLike;
type A = PlatformAccessory;

describe('OwnLightAccessory', () => {
    let platform: ReturnType<typeof makeMockPlatform>;
    let accessory: ReturnType<typeof makeMockAccessory>;
    let handler: OwnLightAccessory;
    beforeEach(() => {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnLightAccessory(platform as unknown as P, accessory as unknown as A, { id: 42, name: 'test-light' });
    });

    it('default name when none provided', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnLightAccessory(p as unknown as P, a as unknown as A, { id: 7 });
        assert.equal(h.name, 'light-7');
    });

    it('throws on non-integer id', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        assert.throws(
            () => new OwnLightAccessory(p as unknown as P, a as unknown as A, { id: 'abc' as unknown as number, name: 'bad' }),
            /invalid accessory id/,
        );
    });

    it('throws on zero id', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        assert.throws(
            () => new OwnLightAccessory(p as unknown as P, a as unknown as A, { id: 0, name: 'bad' }),
            /invalid accessory id/,
        );
    });

    it('throws on negative id', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        assert.throws(
            () => new OwnLightAccessory(p as unknown as P, a as unknown as A, { id: -5, name: 'bad' }),
            /invalid accessory id/,
        );
    });

    it('onData light off', () => {
        handler.value = true;
        handler.onData('*1*0*42##');
        assert.equal(handler.value, false);
    });

    it('onData light on', () => {
        handler.onData('*1*1*42##');
        assert.equal(handler.value, true);
    });

    it('onData dimmer level updates brightness', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnLightAccessory(p as unknown as P, a as unknown as A, { id: 42, name: 'dim', dimmer: true });
        h.onData('*1*5*42##');
        assert.equal(h.value, true);
        assert.equal(h.brightness, 50);
    });

    it('onData dimmer off', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnLightAccessory(p as unknown as P, a as unknown as A, { id: 42, name: 'dim', dimmer: true });
        h.onData('*1*0*42##');
        assert.equal(h.value, false);
    });

    it('onData extended off packet (1000#0) turns light off', () => {
        handler.value = true;
        handler.onData('*1*1000#0*42##');
        assert.equal(handler.value, false);
    });

    it('onData extended on packet (1000#1) turns light on', () => {
        handler.value = false;
        handler.onData('*1*1000#1*42##');
        assert.equal(handler.value, true);
    });

    it('onData unrelated packet logs at debug level', () => {
        const errors: unknown[] = [];
        platform.log.debug = ((...args: unknown[]) => { errors.push(args); }) as typeof platform.log.debug;
        handler.onData('*99*0*42##');
        assert.ok(errors.length > 0);
    });

    it('checkWhere matches id', () => {
        assert.ok(handler.checkWhere('42'));
        assert.ok(!handler.checkWhere('99'));
    });

    it('updateStatus sends status command', () => {
        handler.updateStatus();
        assert.ok(platform.sendCommandSpy.calls.length > 0);
        assert.ok((platform.sendCommandSpy.calls[0][0] as { command: string }).command.includes('*#1*42'));
    });

    it('updateStatus applies standard ON and OFF replies from the command connection', () => {
        handler.updateStatus();
        const command = platform.sendCommandSpy.calls[0][0] as { packet: (pkt: string) => void };
        const on = accessory.services['Lightbulb'].characteristics['On'];
        command.packet('*1*1*42##');
        assert.equal(on.getter!(), true);
        assert.equal(on.value, true);
        command.packet('*1*0*42##');
        assert.equal(on.getter!(), false);
        assert.equal(on.value, false);
    });

    it('updateStatus still applies dimension replies at a custom WHERE address', () => {
        const h = new OwnLightAccessory(platform as unknown as P, accessory as unknown as A, {
            id: 42, where: '68#4#01', dimmer: true,
        });
        try {
            h.updateStatus();
            const command = platform.sendCommandSpy.calls[0][0] as { packet: (pkt: string) => void };
            command.packet('*#1*68#4#01*1*200*0##');
            assert.equal(h.value, true);
            assert.equal(h.brightness, 100);
            command.packet('*1*1000#0*68#4#01##');
            assert.equal(h.value, false);
        } finally {
            h.destroy();
        }
    });

    it('setOnline false sets StatusFault to GENERAL_FAULT', () => {
        const svc = accessory.services['Lightbulb'];
        handler.setOnline(false);
        assert.equal(svc.characteristics['StatusFault'].value, 1);
    });

    it('setOnline true clears StatusFault to NO_FAULT', () => {
        const svc = accessory.services['Lightbulb'];
        handler.setOnline(false);
        handler.setOnline(true);
        assert.equal(svc.characteristics['StatusFault'].value, 0);
    });

    it('identify event triggers blink command sequence', (_t, done) => {
        platform.sendCommandSpy.calls.length = 0;
        handler.value = true;
        accessory.emit('identify', false);
        const cmds1 = platform.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds1.includes('*1*0*42##'), 'initial OFF must be sent');
        setTimeout(() => {
            const cmds2 = platform.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
            assert.ok(cmds2.includes('*1*1*42##'), 'restore ON must be sent after blink');
            handler.destroy();
            done();
        }, 600);
    });

    it('custom where: commands use where address instead of id', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnLightAccessory(p as unknown as P, a as unknown as A, { id: 68, name: 'relay', where: '68#4#01' });
        p.sendCommandSpy.calls.length = 0;
        a.services['Lightbulb'].characteristics['On'].setter!(true);
        const cmds = p.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some(c => c === '*1*1*68#4#01##'), 'must use custom where in on command');
        h.destroy();
    });

    it('custom where: checkWhere matches where string, not bare id', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnLightAccessory(p as unknown as P, a as unknown as A, { id: 68, name: 'relay', where: '68#4#01' });
        assert.ok(h.checkWhere('68#4#01'), 'must match exact where string');
        assert.ok(!h.checkWhere('68'), 'must NOT match bare id when custom where is set');
        h.destroy();
    });

    it('no where: checkWhere matches String(id)', () => {
        assert.ok(handler.checkWhere('42'));
        assert.ok(!handler.checkWhere('42#4#01'));
    });
});

describe('OwnThermostatAccessory', () => {
    let platform: ReturnType<typeof makeMockPlatform>;
    let accessory: ReturnType<typeof makeMockAccessory>;
    let handler: OwnThermostatAccessory;
    beforeEach(() => {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnThermostatAccessory(platform as unknown as P, accessory as unknown as A, { id: 1, name: 'test-thermo', zone: 1 });
    });

    it('default name when none provided', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnThermostatAccessory(p as unknown as P, a as unknown as A, { id: 2, zone: 2 });
        assert.equal(h.name, 'thermostat-2');
    });

    it('targetTemperature initial value is within HAP minValue=5 (no warning at startup)', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnThermostatAccessory(p as unknown as P, a as unknown as A, { id: 1, zone: 1 });
        assert.ok(h.targetTemperature >= 5, 'initial targetTemperature must be >= HAP minValue 5');
        assert.ok(h.targetTemperature <= 30, 'initial targetTemperature must be <= HAP maxValue 30');
    });

    it('updateCharacteristicTargetTemperature clamps below-minimum values to 5', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnThermostatAccessory(p as unknown as P, a as unknown as A, { id: 1, zone: 1 });
        h.updateCharacteristicTargetTemperature(0);
        assert.equal(h.targetTemperature, 5, '0°C must be clamped to HAP minValue 5');
        h.updateCharacteristicTargetTemperature(50);
        assert.equal(h.targetTemperature, 30, '50°C must be clamped to HAP maxValue 30');
        h.updateCharacteristicTargetTemperature(22);
        assert.equal(h.targetTemperature, 22, 'in-range values must pass through');
    });

    it('throws when zone is missing', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        assert.throws(
            () => new OwnThermostatAccessory(p as unknown as P, a as unknown as A, { id: 2, name: 'bad' } as unknown as import('../lib/OwnAccessory').ThermostatConfig),
            /requires a positive integer "zone"/,
        );
    });

    it('throws when zone is zero', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        assert.throws(
            () => new OwnThermostatAccessory(p as unknown as P, a as unknown as A, { id: 2, name: 'bad', zone: 0 }),
            /requires a positive integer "zone"/,
        );
    });

    it('throws when zone is not integer', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        assert.throws(
            () => new OwnThermostatAccessory(p as unknown as P, a as unknown as A, { id: 2, name: 'bad', zone: 1.5 }),
            /requires a positive integer "zone"/,
        );
    });

    it('onData current temperature', () => {
        handler.onData('*#4*1*0*0210##');
        assert.equal(handler.temperature, 21);
    });

    it('onData target temperature', () => {
        handler.onData('*#4*1*14*0180*3##');
        assert.equal(handler.targetTemperature, 18);
    });

    it('DIM 14 mode byte adopts HEAT/COOL only when no explicit choice is set', () => {
        // From OFF (no explicit user choice) a DIM 14 setpoint in Heat mode adopts HEAT.
        handler.targetHeatingCoolingState = HEATING_COOLING_TARGET.OFF;
        handler.onData('*#4*1*14*0210*1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.HEAT,
            'DIM 14 Heat mode should set HEAT when starting from OFF');
    });

    it('DIM 14 mode byte does NOT override an explicit HEAT/COOL choice', () => {
        // Regression: a passive setpoint broadcast in Heat mode must not flip a user who
        // deliberately selected COOL in HomeKit.
        handler.targetHeatingCoolingState = HEATING_COOLING_TARGET.COOL;
        handler.onData('*#4*1*14*0210*1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.COOL,
            'DIM 14 Heat setpoint must not override the user\'s explicit COOL choice');
        assert.equal(handler.targetTemperature, 21,
            'the setpoint temperature is still applied even when the mode is not adopted');
    });

    for (const mode of ['auto', 'off'] as const) {
        for (const source of ['command', 'bus'] as const) {
            it(`DIM 14 preserves ${mode} established by ${source} and keeps setpoint writes blocked`, async () => {
                if (source === 'command') await handler.execute({ type: 'mode', value: mode });
                else handler.onData(`*4*${mode === 'auto' ? 1101 : 103}*#0#1##`);
                const before = platform.sendCommandSpy.calls.length;
                for (const modeByte of [1, 2, 3]) {
                    handler.onData(`*#4*1*14*0210*${modeByte}##`);
                    assert.equal(handler.snapshot().mode, mode);
                    assert.equal(handler.snapshot().targetTemperature, 21);
                    assert.throws(() => handler.execute({ type: 'temperature', value: 23 }),
                        (error: unknown) => (error as { code: number }).code === -70412);
                }
                assert.equal(platform.sendCommandSpy.calls.length, before);
            });
        }
    }

    it('onData valve status sets heating', () => {
        handler.onData('*#4*1*19*0*1##');
        assert.equal(handler.heatingCoolingState, HEATING_COOLING_CURRENT.HEAT);
    });

    it('onData valve status sets cooling', () => {
        handler.onData('*#4*1*19*1*0##');
        assert.equal(handler.heatingCoolingState, HEATING_COOLING_CURRENT.COOL);
    });

    it('onData operation mode OFF', () => {
        handler.onData('*4*103*#0#1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.OFF);
    });

    it('onData manual heating with temperature', () => {
        handler.onData('*4*110#0180*#0#1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.HEAT);
        assert.equal(handler.targetTemperature, 18);
    });

    it('onData auto program', () => {
        handler.onData('*4*1101*#0#1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.AUTO);
    });

    it('onData antifreeze sets OFF', () => {
        handler.onData('*4*102*#0#1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.OFF);
    });

    it('checkWhere matches address', () => {
        assert.ok(handler.checkWhere('#0#1'));
    });

    it('checkWhere matches numeric id', () => {
        assert.ok(handler.checkWhere('1'));
    });

    it('checkWhere rejects non-matching', () => {
        assert.ok(!handler.checkWhere('99'));
    });

    it('onData DIM 19 both valves inactive after cooling sets OFF', () => {
        handler.onData('*#4*1*19*1*0##');
        assert.equal(handler.heatingCoolingState, HEATING_COOLING_CURRENT.COOL);
        handler.onData('*#4*1*19*0*0##');
        assert.equal(handler.heatingCoolingState, HEATING_COOLING_CURRENT.OFF);
    });

    it('onData DIM 20 actuator status logs without sending a command', () => {
        platform.sendCommandSpy.calls.length = 0;
        handler.onData('*#4*1#1*20*1##');
        assert.equal(platform.sendCommandSpy.calls.length, 0);
    });

    it('onData operation mode matches zone >= 10', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnThermostatAccessory(p as unknown as P, a as unknown as A, { id: 1, name: 'T', zone: 10 });
        h.onData('*4*103*#0#10##');
        assert.equal(h.targetHeatingCoolingState, HEATING_COOLING_TARGET.OFF);
    });

    it('TargetHeatingCoolingState onSet HEAT sends manual heat command', () => {
        const svc = accessory.services['Thermostat'];
        handler.targetTemperature = 20;
        platform.sendCommandSpy.calls.length = 0;
        svc.characteristics['TargetHeatingCoolingState'].setter!(HEATING_COOLING_TARGET.HEAT);
        const cmds = platform.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c.startsWith('*#4*#0#1*#14*') && c.endsWith('*1##')));
    });

    it('TargetHeatingCoolingState onSet COOL sends manual cool command', () => {
        const svc = accessory.services['Thermostat'];
        handler.targetTemperature = 22;
        platform.sendCommandSpy.calls.length = 0;
        svc.characteristics['TargetHeatingCoolingState'].setter!(HEATING_COOLING_TARGET.COOL);
        const cmds = platform.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c.startsWith('*#4*#0#1*#14*') && c.endsWith('*2##')),
            'expected COOL command (mode byte 2), got: ' + cmds.join(', '));
    });

    it('TargetTemperature onSet in COOL mode sends cool command', () => {
        const svc = accessory.services['Thermostat'];
        handler.targetHeatingCoolingState = HEATING_COOLING_TARGET.COOL;
        platform.sendCommandSpy.calls.length = 0;
        svc.characteristics['TargetTemperature'].setter!(22);
        const cmds = platform.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c.startsWith('*#4*#0#1*#14*') && c.endsWith('*2##')));
    });

    it('TargetHeatingCoolingState onSet OFF sends stop command', () => {
        const svc = accessory.services['Thermostat'];
        platform.sendCommandSpy.calls.length = 0;
        svc.characteristics['TargetHeatingCoolingState'].setter!(HEATING_COOLING_TARGET.OFF);
        const cmds = platform.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c === '*4*303*#0#1##'));
    });

    it('TargetTemperature onSet in HEAT mode sends temperature command', () => {
        const svc = accessory.services['Thermostat'];
        handler.targetHeatingCoolingState = HEATING_COOLING_TARGET.HEAT;
        platform.sendCommandSpy.calls.length = 0;
        svc.characteristics['TargetTemperature'].setter!(21);
        const cmds = platform.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c.startsWith('*#4*#0#1*#14*')));
    });

    it('TargetTemperature onSet in non-HEAT mode throws HapStatusError', () => {
        const svc = accessory.services['Thermostat'];
        handler.targetHeatingCoolingState = HEATING_COOLING_TARGET.OFF;
        assert.throws(
            () => svc.characteristics['TargetTemperature'].setter!(21),
            (err: unknown) => (err as { code: number }).code === -70412,
        );
    });

    it('setOnline false sets StatusFault to GENERAL_FAULT', () => {
        const svc = accessory.services['Thermostat'];
        handler.setOnline(false);
        assert.equal(svc.characteristics['StatusFault'].value, 1);
    });

    it('setOnline true clears StatusFault to NO_FAULT', () => {
        const svc = accessory.services['Thermostat'];
        handler.setOnline(false);
        handler.setOnline(true);
        assert.equal(svc.characteristics['StatusFault'].value, 0);
    });
});

describe('OwnScenarioAccessory', () => {
    let platform: ReturnType<typeof makeMockPlatform>;
    let accessory: ReturnType<typeof makeMockAccessory>;
    let handler: OwnScenarioAccessory;
    beforeEach(() => {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnScenarioAccessory(platform as unknown as P, accessory as unknown as A, { id: 5, name: 'test-scenario' });
    });

    it('default name when none provided', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnScenarioAccessory(p as unknown as P, a as unknown as A, { id: 3 });
        assert.equal(h.name, 'scenario-3');
    });

    it('checkWhere always returns false', () => {
        assert.ok(!handler.checkWhere('5'));
        assert.ok(!handler.checkWhere('0'));
    });

    it('onData is a no-op', () => {
        handler.onData('*0*5*0##');
    });

    it('removes any pre-existing StatelessProgrammableSwitch left over from the deprecated asButton mode', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        a.addService('StatelessProgrammableSwitch'); // simulate an old install with asButton: true
        const h = new OwnScenarioAccessory(p as unknown as P, a as unknown as A, { id: 13, name: 'sw' });
        assert.ok(a.services['Switch'], 'Switch must be created');
        assert.ok(!a.services['StatelessProgrammableSwitch'], 'deprecated StatelessProgrammableSwitch must be removed');
        h.destroy();
    });
});

describe('OwnContactAccessory', () => {
    let platform: ReturnType<typeof makeMockPlatform>;
    let accessory: ReturnType<typeof makeMockAccessory>;
    let handler: OwnContactAccessory;
    beforeEach(() => {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnContactAccessory(platform as unknown as P, accessory as unknown as A, { id: 55, name: 'test-contact' });
    });

    it('default name when none provided', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnContactAccessory(p as unknown as P, a as unknown as A, { id: 8 });
        assert.equal(h.name, 'contact-8');
    });

    it('restores configuredName from accessory.context across restart', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        a.context.configuredName = 'My Renamed Sensor';
        const h = new OwnContactAccessory(p as unknown as P, a as unknown as A, { id: 99, name: 'config-name' });
        assert.equal(h.name, 'My Renamed Sensor', 'name must be loaded from context.configuredName');
    });

    it('ConfiguredName onSet persists rename and updates displayName', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a as any).displayName = 'old';
        const h = new OwnContactAccessory(p as unknown as P, a as unknown as A, { id: 100, name: 'config-name' });
        const svc = a.services['ContactSensor'];
        svc.characteristics['ConfiguredName'].setter!('Renamed in Home');
        assert.equal(a.context.configuredName, 'Renamed in Home');
        assert.equal(h.name, 'Renamed in Home');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.equal((a as any).displayName, 'Renamed in Home', 'displayName must be synced');
        // updateAccessory should have been called once to push the displayName change to Homebridge
        assert.equal(p.updateAccessorySpy.calls.length, 1, 'platform.updateAccessory must be called on rename');
    });

    it('onData contact detected', () => {
        handler.onData('*9*0*55##');
        assert.equal(handler.contactState, CONTACT_STATE.CONTACT_DETECTED);
    });

    it('onData contact not detected', () => {
        handler.onData('*9*1*55##');
        assert.equal(handler.contactState, CONTACT_STATE.CONTACT_NOT_DETECTED);
    });

    it('unknown packet logs error', () => {
        const errors: unknown[] = [];
        platform.log.error = ((...args: unknown[]) => { errors.push(args); }) as typeof platform.log.error;
        handler.onData('*99*0*55##');
        assert.ok(errors.length > 0);
    });

    it('checkWhere matches', () => {
        assert.ok(handler.checkWhere('55'));
        assert.ok(!handler.checkWhere('99'));
    });

    it('updateStatus sends command', () => {
        handler.updateStatus();
        assert.ok(platform.sendCommandSpy.calls.length > 0);
        assert.ok((platform.sendCommandSpy.calls[0][0] as { command: string }).command.includes('*#9*55'));
    });

    it('setOnline false sets StatusActive false and StatusFault to GENERAL_FAULT', () => {
        const svc = accessory.services['ContactSensor'];
        handler.setOnline(false);
        assert.equal(svc.characteristics['StatusActive'].value, false);
        assert.equal(svc.characteristics['StatusFault'].value, 1);
    });

    it('setOnline true clears StatusFault to NO_FAULT', () => {
        const svc = accessory.services['ContactSensor'];
        handler.setOnline(false);
        handler.setOnline(true);
        assert.equal(svc.characteristics['StatusActive'].value, true);
        assert.equal(svc.characteristics['StatusFault'].value, 0);
    });

    it('sensorType motion creates MotionSensor service', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnContactAccessory(p as unknown as P, a as unknown as A, { id: 60, name: 'pir', sensorType: 'motion' });
        assert.ok(a.services['MotionSensor']);
        assert.ok(!a.services['ContactSensor']);
        // contact OPEN (1) → motion detected (true)
        h.onData('*9*1*60##');
        assert.equal(a.services['MotionSensor'].characteristics['MotionDetected'].value, true);
        h.onData('*9*0*60##');
        assert.equal(a.services['MotionSensor'].characteristics['MotionDetected'].value, false);
    });

    it('sensorType occupancy creates OccupancySensor service', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnContactAccessory(p as unknown as P, a as unknown as A, { id: 61, name: 'occ', sensorType: 'occupancy' });
        assert.ok(a.services['OccupancySensor']);
        h.onData('*9*1*61##');
        assert.equal(a.services['OccupancySensor'].characteristics['OccupancyDetected'].value, true);
    });

    it('sensorType leak creates LeakSensor service with 0/1 alarm states', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnContactAccessory(p as unknown as P, a as unknown as A, { id: 62, name: 'leak', sensorType: 'leak' });
        assert.ok(a.services['LeakSensor']);
        h.onData('*9*0*62##');
        assert.equal(a.services['LeakSensor'].characteristics['LeakDetected'].value, 0, 'closed contact = NOT_DETECTED');
        h.onData('*9*1*62##');
        assert.equal(a.services['LeakSensor'].characteristics['LeakDetected'].value, 1, 'open contact = DETECTED');
    });

    it('sensorType smoke creates SmokeSensor service', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnContactAccessory(p as unknown as P, a as unknown as A, { id: 63, sensorType: 'smoke' });
        assert.ok(a.services['SmokeSensor']);
        h.onData('*9*1*63##');
        assert.equal(a.services['SmokeSensor'].characteristics['SmokeDetected'].value, 1);
    });

    it('sensorType co creates CarbonMonoxideSensor service', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnContactAccessory(p as unknown as P, a as unknown as A, { id: 64, sensorType: 'co' });
        assert.ok(a.services['CarbonMonoxideSensor']);
        h.onData('*9*1*64##');
        assert.equal(a.services['CarbonMonoxideSensor'].characteristics['CarbonMonoxideDetected'].value, 1);
    });

    it('sensorType flip removes stale service from previous run', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        a.addService('ContactSensor'); // simulate stale service from previous run
        new OwnContactAccessory(p as unknown as P, a as unknown as A, { id: 70, sensorType: 'motion' });
        assert.ok(!a.services['ContactSensor'], 'old ContactSensor must be removed');
        assert.ok(a.services['MotionSensor']);
    });
});

describe('OwnEnergyAccessory', () => {
    let platform: ReturnType<typeof makeMockPlatform>;
    let accessory: ReturnType<typeof makeMockAccessory>;
    let handler: OwnEnergyAccessory;
    beforeEach(() => {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnEnergyAccessory(platform as unknown as P, accessory as unknown as A, { id: 71, name: 'test-energy' });
    });
    afterEach(() => {
        handler.destroy();
    });

    it('default name when none provided', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnEnergyAccessory(p as unknown as P, a as unknown as A, { id: 9 });
        assert.equal(h.name, 'energy-9');
        h.destroy();
    });

    it('onData sets watts', () => {
        handler.onData('*#18*71*113*350##');
        assert.equal(handler.watts, 350);
    });

    it('onData zero watts stays zero in the device state', () => {
        handler.onData('*#18*71*113*0##');
        assert.equal(handler.watts, 0);
        assert.equal(accessory.services.LightSensor.characteristics.CurrentAmbientLightLevel.value, 0.0001);
    });

    it('non-113 dimension packet is ignored', () => {
        handler.watts = 100;
        handler.onData('*#18*71*112*999##');
        assert.equal(handler.watts, 100);
    });

    it('updateStatus sends command', () => {
        handler.updateStatus();
        assert.ok(platform.sendCommandSpy.calls.length > 0);
        assert.ok((platform.sendCommandSpy.calls[0][0] as { command: string }).command.includes('*#18*71*113'));
    });

    it('destroy clears interval', () => {
        handler.destroy();
    });

    it('checkWhere matches', () => {
        assert.ok(handler.checkWhere('71'));
        assert.ok(!handler.checkWhere('99'));
    });

    it('setOnline false sets StatusActive false and StatusFault to GENERAL_FAULT', () => {
        const svc = accessory.services['LightSensor'];
        handler.setOnline(false);
        assert.equal(svc.characteristics['StatusActive'].value, false);
        assert.equal(svc.characteristics['StatusFault'].value, 1);
    });

    it('setOnline true clears StatusFault to NO_FAULT', () => {
        const svc = accessory.services['LightSensor'];
        handler.setOnline(false);
        handler.setOnline(true);
        assert.equal(svc.characteristics['StatusActive'].value, true);
        assert.equal(svc.characteristics['StatusFault'].value, 0);
    });

    it('asOutlet: true creates Outlet service and removes LightSensor', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        a.addService('LightSensor'); // simulate previous run
        const h = new OwnEnergyAccessory(p as unknown as P, a as unknown as A, { id: 80, asOutlet: true });
        assert.ok(a.services['Outlet']);
        assert.ok(!a.services['LightSensor'], 'old LightSensor must be removed');
        h.destroy();
    });

    it('asOutlet: true updates On + OutletInUse based on watt threshold', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnEnergyAccessory(p as unknown as P, a as unknown as A, { id: 81, asOutlet: true });
        const svc = a.services['Outlet'];
        h.onData('*#18*81*113*0##');     // 0 W → not in use
        assert.equal(svc.characteristics['On'].value, false);
        assert.equal(svc.characteristics['OutletInUse'].value, false);
        h.onData('*#18*81*113*250##');   // 250 W → in use
        assert.equal(svc.characteristics['On'].value, true);
        assert.equal(svc.characteristics['OutletInUse'].value, true);
        h.destroy();
    });

    it('asOutlet: false (legacy) flip removes any pre-existing Outlet service', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        a.addService('Outlet'); // simulate previous run with asOutlet=true
        const h = new OwnEnergyAccessory(p as unknown as P, a as unknown as A, { id: 82 });
        assert.ok(a.services['LightSensor']);
        assert.ok(!a.services['Outlet'], 'old Outlet must be removed');
        h.destroy();
    });

    it('onData no-op after destroy', () => {
        handler.destroy();
        const wattsBefore = handler.watts;
        handler.onData('*#18*71*113*999##');
        assert.equal(handler.watts, wattsBefore, 'onData must not mutate state after destroy');
    });
});


describe("OwnDoorAccessory", () => {
    let platform: ReturnType<typeof makeMockPlatform>;
    let accessory: ReturnType<typeof makeMockAccessory>;
    let handler: OwnDoorAccessory;
    beforeEach(() => {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService("AccessoryInformation");
        handler = new OwnDoorAccessory(platform as unknown as P, accessory as unknown as A, { id: 91, name: "front-door" });
    });
    afterEach(() => { handler.destroy(); });

    it("creates LockMechanism service", () => {
        assert.ok(accessory.services["LockMechanism"]);
    });

    it("LockTargetState UNSECURED sends open command and reverts after 3s", () => {
        const svc = accessory.services["LockMechanism"];
        platform.sendCommandSpy.calls.length = 0;
        svc.characteristics["LockTargetState"].setter!(0); // UNSECURED
        const cmds = platform.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.includes("*7*19*91##"), "expected default door open command, got: " + cmds.join(", "));
        assert.equal(svc.characteristics["LockCurrentState"].value, 0, "current state should be UNSECURED");
    });

    it("custom openCommand is sent when configured", () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService("AccessoryInformation");
        const h = new OwnDoorAccessory(p as unknown as P, a as unknown as A, { id: 92, openCommand: "*7*40*92##" });
        const svc = a.services["LockMechanism"];
        p.sendCommandSpy.calls.length = 0;
        svc.characteristics["LockTargetState"].setter!(0);
        const cmds = p.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.includes("*7*40*92##"));
        h.destroy();
    });

    it("doorbell:true creates linked Doorbell service and fires SINGLE_PRESS on incoming ring packet", () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService("AccessoryInformation");
        const h = new OwnDoorAccessory(p as unknown as P, a as unknown as A, { id: 93, doorbell: true });
        assert.ok(a.services["Doorbell"], "Doorbell service must be created");
        h.onData("*7*8*93##");
        assert.equal(a.services["Doorbell"].characteristics["ProgrammableSwitchEvent"].value, 0, "SINGLE_PRESS must fire on ring");
        h.destroy();
    });

    it("checkWhere matches numeric id", () => {
        assert.ok(handler.checkWhere("91"));
        assert.ok(!handler.checkWhere("92"));
    });

    it("doorbell does NOT fire on echo of own open command (event=19 by default)", () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService("AccessoryInformation");
        const h = new OwnDoorAccessory(p as unknown as P, a as unknown as A, { id: 95, doorbell: true });
        const svc = a.services["Doorbell"];
        // Pre-set to ensure we can detect change. Trigger a real ring first to validate test setup.
        h.onData("*7*8*95##");
        assert.equal(svc.characteristics["ProgrammableSwitchEvent"].value, 0);
        // Reset
        svc.characteristics["ProgrammableSwitchEvent"].value = -1;
        // Now simulate the echo of the open command
        h.onData("*7*19*95##");
        assert.equal(svc.characteristics["ProgrammableSwitchEvent"].value, -1, "echo must not fire doorbell");
        h.destroy();
    });

    it("doorbell fires on broadcast packets (where=0)", () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService("AccessoryInformation");
        const h = new OwnDoorAccessory(p as unknown as P, a as unknown as A, { id: 96, doorbell: true });
        const svc = a.services["Doorbell"];
        h.onData("*7*8*0##");
        assert.equal(svc.characteristics["ProgrammableSwitchEvent"].value, 0, "broadcast ring must fire doorbell");
        h.destroy();
    });

    it("checkWhere accepts where=0 broadcast when doorbell enabled", () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService("AccessoryInformation");
        const h = new OwnDoorAccessory(p as unknown as P, a as unknown as A, { id: 97, doorbell: true });
        assert.ok(h.checkWhere("0"), "doorbell-enabled door must accept broadcast");
        const a2 = makeMockAccessory();
        a2.addService("AccessoryInformation");
        const h2 = new OwnDoorAccessory(p as unknown as P, a2 as unknown as A, { id: 98 });
        assert.ok(!h2.checkWhere("0"), "non-doorbell door must NOT match where=0");
        h.destroy(); h2.destroy();
    });

    it("LockCurrentState.onGet tracks state across the post-open window", () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService("AccessoryInformation");
        const h = new OwnDoorAccessory(p as unknown as P, a as unknown as A, { id: 100, name: "front" });
        const svc = a.services["LockMechanism"];
        // SECURED initially
        assert.equal(svc.characteristics["LockCurrentState"].getter!(), 1, "SECURED initially");
        // Trigger open
        svc.characteristics["LockTargetState"].setter!(0);
        // Now onGet should report UNSECURED
        assert.equal(svc.characteristics["LockCurrentState"].getter!(), 0, "UNSECURED after open");
        h.destroy();
    });

    it("custom openCommand: echo filter uses parsed event code, not literal 19", () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService("AccessoryInformation");
        const h = new OwnDoorAccessory(p as unknown as P, a as unknown as A, { id: 99, doorbell: true, openCommand: "*7*40*99##" });
        const svc = a.services["Doorbell"];
        svc.characteristics["ProgrammableSwitchEvent"].value = -1;
        // Echo of custom open command (event=40) should NOT fire doorbell
        h.onData("*7*40*99##");
        assert.equal(svc.characteristics["ProgrammableSwitchEvent"].value, -1, "custom-event echo must not fire doorbell");
        // But event=8 (a real ring) should
        h.onData("*7*8*99##");
        assert.equal(svc.characteristics["ProgrammableSwitchEvent"].value, 0, "different-event ring must fire doorbell");
        h.destroy();
    });
});
