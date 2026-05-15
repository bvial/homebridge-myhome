import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeMockPlatform, makeMockAccessory, POSITION_STATE, HEATING_COOLING_CURRENT, HEATING_COOLING_TARGET, CONTACT_STATE } from './helpers';
import type { OwnPlatformLike } from '../lib/OwnAccessory';
import type { PlatformAccessory } from 'homebridge';
import {
    OwnLightAccessory,
    OwnBlindAccessory,
    OwnThermostatAccessory,
    OwnScenarioAccessory,
    OwnContactAccessory,
    OwnEnergyAccessory,
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
        assert.equal(h.brightness, Math.round((5 - 2) / 8 * 100));
    });

    it('onData dimmer off', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnLightAccessory(p as unknown as P, a as unknown as A, { id: 42, name: 'dim', dimmer: true });
        h.onData('*1*0*42##');
        assert.equal(h.value, false);
    });

    it('onData unknown packet logs error', () => {
        const errors: unknown[] = [];
        platform.log.error = ((...args: unknown[]) => { errors.push(args); }) as typeof platform.log.error;
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
});

describe('OwnBlindAccessory', () => {
    let platform: ReturnType<typeof makeMockPlatform>;
    let accessory: ReturnType<typeof makeMockAccessory>;
    let handler: OwnBlindAccessory;
    beforeEach(() => {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnBlindAccessory(platform as unknown as P, accessory as unknown as A, { id: 23, name: 'test-blind', time: 30, timeSlat: 0, slatPercent: 0 });
    });
    afterEach(() => { handler.destroy(); });

    it('default name when none provided', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnBlindAccessory(p as unknown as P, a as unknown as A, { id: 5, time: 20 });
        assert.equal(h.name, 'blind-5');
    });

    it('throws when time is zero', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        assert.throws(
            () => new OwnBlindAccessory(p as unknown as P, a as unknown as A, { id: 5, name: 'bad', time: 0 }),
            /requires a positive "time" value/,
        );
    });

    it('throws when time is missing', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        assert.throws(
            () => new OwnBlindAccessory(p as unknown as P, a as unknown as A, { id: 5, name: 'bad' } as unknown as import('../lib/OwnAccessory').BlindConfig),
            /requires a positive "time" value/,
        );
    });

    it('throws when time is negative', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        assert.throws(
            () => new OwnBlindAccessory(p as unknown as P, a as unknown as A, { id: 5, name: 'bad', time: -10 }),
            /requires a positive "time" value/,
        );
    });

    it('onData stop', () => {
        handler.position = 50;
        handler.target = 50;
        handler.onData('*2*0*23##');
        assert.equal(handler.state, POSITION_STATE.STOPPED);
        assert.equal(handler.position, 50);
    });

    it('onData stop snaps position when within 3', () => {
        handler.position = 48;
        handler.target = 50;
        handler.onData('*2*0*23##');
        assert.equal(handler.position, 50);
    });

    it('onData increasing', () => {
        handler.onData('*2*1*23##');
        assert.equal(handler.state, POSITION_STATE.INCREASING);
    });

    it('onData decreasing', () => {
        handler.onData('*2*2*23##');
        assert.equal(handler.state, POSITION_STATE.DECREASING);
    });

    it('unknown packet logs at debug level', () => {
        const debugs: unknown[] = [];
        platform.log.debug = ((...args: unknown[]) => { debugs.push(args); }) as typeof platform.log.debug;
        handler.onData('*99*0*23##');
        assert.ok(debugs.length > 0);
    });

    it('onData extended 1000#2 treated as DECREASING', () => {
        handler.onData('*2*1000#2*23##');
        assert.equal(handler.state, POSITION_STATE.DECREASING);
    });

    it('onData extended 1000#0 treated as STOPPED', () => {
        handler.state = POSITION_STATE.DECREASING;
        handler.onData('*2*1000#0*23##');
        assert.equal(handler.state, POSITION_STATE.STOPPED);
    });

    it('msPerPercent without slat', () => {
        assert.equal(handler.msPerPercent(50), (30 / 100) * 1000);
    });

    it('msPerPercent with slat in slat zone', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnBlindAccessory(p as unknown as P, a as unknown as A, { id: 1, name: 'v', time: 30, timeSlat: 5, slatPercent: 10 });
        const ms = h.msPerPercent(5);
        assert.equal(ms, Math.max(50, (5 / 10) * 1000));
    });

    it('msPerPercent with slat outside slat zone', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnBlindAccessory(p as unknown as P, a as unknown as A, { id: 1, name: 'v', time: 30, timeSlat: 5, slatPercent: 10 });
        const ms = h.msPerPercent(50);
        assert.equal(ms, (30 / 90) * 1000);
    });

    it('checkWhere matches', () => {
        assert.ok(handler.checkWhere('23'));
        assert.ok(!handler.checkWhere('99'));
    });

    it('destroy clears timeouts', () => {
        handler.moveTrackingTimeout = setTimeout(() => {}, 100000);
        handler.packetTimeout = setTimeout(() => {}, 100000);
        handler.positionTimeout = setTimeout(() => {}, 100000);
        handler.destroy();
    });

    it('startMoveTracking stops scheduling when retry limit exceeded', () => {
        handler.moveRetries = 30;
        handler.commandSent = true;
        handler.startMoveTracking();
        assert.strictEqual(handler.moveTrackingTimeout, undefined);
        assert.equal(handler.moveRetries || 0, 0);
    });

    it('stopMoveTracking resets retry counter', () => {
        handler.moveRetries = 20;
        handler.stopMoveTracking();
        assert.equal(handler.moveRetries || 0, 0);
    });

    it('startMoveTracking schedules normally when under retry limit', () => {
        handler.moveRetries = 0;
        handler.startMoveTracking();
        assert.notEqual(handler.moveTrackingTimeout, undefined);
        handler.destroy();
    });

    it('evaluatePosition stops and sends stop command when position reaches target while INCREASING', () => {
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        handler.state = POSITION_STATE.INCREASING;
        handler.expectedState = POSITION_STATE.INCREASING;
        handler.homeKitMovement = true;
        handler.target = 50;
        handler.position = 49;
        handler.evaluatePosition();
        assert.equal(handler.position, 50);
        assert.equal(handler.expectedState, POSITION_STATE.STOPPED);
        const cmds = spy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c === '*2*0*23##'), 'expected stop command *2*0*23##, got: ' + cmds.join(', '));
        handler.destroy();
    });

    it('updateStatus init phase sets _initPhase and sends move-down', () => {
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        assert.equal(handler.initStartPosition, false);
        handler.updateStatus();
        assert.equal(handler.initPhase, true);
        assert.equal(handler.initStartPosition, true);
        const cmds = spy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c === '*2*2*23##'));
    });

    it('evaluatePosition during init does not send stop when DECREASING at target', () => {
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        handler.initPhase = true;
        handler.state = POSITION_STATE.DECREASING;
        handler.position = 0;
        handler.target = 0;
        handler.evaluatePosition();
        const cmds = spy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(!cmds.some((c: string) => c.startsWith('*2*0*')), 'stop command must not be sent during init phase');
        handler.destroy();
    });

    it('onData STOP clears _initPhase when was DECREASING', () => {
        handler.initPhase = true;
        handler.state = POSITION_STATE.DECREASING;
        handler.onData('*2*0*23##');
        assert.equal(handler.initPhase, false);
    });

    it('onData STOP does not clear _initPhase when state was STOPPED (gateway state broadcast)', () => {
        handler.initPhase = true;
        handler.state = POSITION_STATE.STOPPED;
        handler.onData('*2*0*23##');
        assert.equal(handler.initPhase, true, 'initPhase must survive a state broadcast before DECREASING echo');
    });

    it('onData duplicate STOP does not call evaluatePosition when already STOPPED', () => {
        handler.state = POSITION_STATE.STOPPED;
        let evalCalled = 0;
        const orig = handler.evaluatePosition.bind(handler);
        handler.evaluatePosition = () => { evalCalled++; orig(); };
        handler.onData('*2*0*23##');
        assert.equal(evalCalled, 0, 'evaluatePosition must not be called for duplicate STOP');
    });

    it('onData duplicate DECREASING does not call evaluatePosition when already DECREASING', () => {
        handler.state = POSITION_STATE.DECREASING;
        let evalCalled = 0;
        const orig = handler.evaluatePosition.bind(handler);
        handler.evaluatePosition = () => { evalCalled++; orig(); };
        handler.onData('*2*2*23##');
        assert.equal(evalCalled, 0, 'evaluatePosition must not be called for duplicate DECREASING');
        handler.destroy();
    });

    it('evaluatePosition physical UP (homeKitMovement=false) does not send stop even at target', () => {
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        handler.homeKitMovement = false;
        handler.state = POSITION_STATE.INCREASING;
        handler.position = 0;
        handler.target = 0;
        handler.evaluatePosition();
        const cmds = spy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(!cmds.some((c: string) => c.startsWith('*2*0*')), 'physical UP must not trigger stop');
        assert.notEqual(handler.positionTimeout, undefined, 'position tracking must continue');
        handler.destroy();
    });

    it('evaluatePosition physical DOWN (homeKitMovement=false) does not send stop even at target', () => {
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        handler.homeKitMovement = false;
        handler.state = POSITION_STATE.DECREASING;
        handler.position = 5;
        handler.target = 5;
        handler.evaluatePosition();
        const cmds = spy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(!cmds.some((c: string) => c.startsWith('*2*0*')), 'physical DOWN must not trigger stop');
        assert.notEqual(handler.positionTimeout, undefined, 'position tracking must continue');
        handler.destroy();
    });

    it('physical override cancels HomeKit movement when direction changes unexpectedly', () => {
        // HomeKit movement going UP, physical DOWN button pressed
        handler.homeKitMovement = true;
        handler.state = POSITION_STATE.INCREASING;
        handler.position = 50;
        handler.target = 80;
        handler.positionTimeout = setTimeout(() => {}, 100000);  // timer running

        handler.onData('*2*2*23##');  // physical DOWN

        assert.equal(handler.homeKitMovement, false, 'homeKitMovement must be cleared on physical override');
        // positionTimeout is re-set by evaluatePosition() for physical tracking — not undefined
        assert.equal(handler.state, POSITION_STATE.DECREASING, 'state must reflect physical direction');
        handler.destroy();
    });

    it('evaluatePosition during init stops rescheduling when position reaches 0', () => {
        handler.initPhase = true;
        handler.state = POSITION_STATE.DECREASING;
        handler.position = 0;
        handler.target = 0;
        handler.evaluatePosition();
        assert.equal(handler.positionTimeout, undefined);
    });

    it('move() with pending command retries without incrementing _moveRetries', () => {
        handler.commandSent = true;
        handler.moveRetries = 5;
        handler.target = 80;
        handler.position = 20;
        handler.move();
        assert.equal(handler.moveRetries, 5);
        assert.notEqual(handler.moveTrackingTimeout, undefined);
        handler.destroy();
    });

    it('move() issues moveUp when target > position', () => {
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        handler.state = POSITION_STATE.STOPPED;
        handler.position = 20;
        handler.target = 80;
        handler.move();
        const cmds = spy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c === '*2*1*23##'));
        handler.destroy();
    });

    it('move() issues moveDown when target < position', () => {
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        handler.state = POSITION_STATE.STOPPED;
        handler.position = 80;
        handler.target = 20;
        handler.move();
        const cmds = spy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c === '*2*2*23##'));
        handler.destroy();
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
        assert.ok(cmds.some((c: string) => c.startsWith('*#4*#0#1*#14*')));
    });

    it('TargetHeatingCoolingState onSet OFF sends stop command', () => {
        const svc = accessory.services['Thermostat'];
        platform.sendCommandSpy.calls.length = 0;
        svc.characteristics['TargetHeatingCoolingState'].setter!(HEATING_COOLING_TARGET.OFF);
        const cmds = platform.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c === '*4*103*#0#1##'));
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

    it('onData zero watts floors to 0.0001', () => {
        handler.onData('*#18*71*113*0##');
        assert.equal(handler.watts, 0.0001);
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
});
