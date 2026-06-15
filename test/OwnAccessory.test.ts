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

    it('onData stop snaps position to target when within 3 during HomeKit movement', () => {
        handler.position = 48;
        handler.target = 50;
        handler.homeKitMovement = true;
        handler.onData('*2*0*23##');
        assert.equal(handler.position, 50, 'position must snap to target during HomeKit movement');
    });

    it('onData stop does NOT snap position during physical movement', () => {
        handler.position = 48;
        handler.target = 50;
        handler.homeKitMovement = false;
        handler.onData('*2*0*23##');
        assert.equal(handler.position, 48, 'position must NOT snap during physical movement');
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
        handler.moveRetries = 31; // one past BLIND_MAX_MOVE_RETRIES (30)
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

    it('startMoveTracking does NOT increment moveRetries (single source of truth is move() pending path)', () => {
        // Bug B fix: previously startMoveTracking incremented moveRetries when commandSent=true,
        // and move()'s commandIsPending path also incremented — double-counting.
        // Now: only move()'s pending path increments. startMoveTracking just schedules.
        handler.moveRetries = 5;
        handler.commandSent = true;
        handler.startMoveTracking();
        assert.equal(handler.moveRetries, 5, 'startMoveTracking must not bump moveRetries');
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

    it('calibrateOnStart:false restores cached position without sending move-down', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        a.context.blindPosition = 65;
        const h = new OwnBlindAccessory(p as unknown as P, a as unknown as A,
            { id: 30, name: 'test', time: 20, calibrateOnStart: false });
        assert.equal(h.position, 65, 'position must be restored from cache');
        assert.equal(h.target, 65, 'target must match restored position');
        p.sendCommandSpy.calls.length = 0;
        h.updateStatus();
        const cmds = p.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(!cmds.some((c: string) => c.startsWith('*2*2*')), 'no calibration move-down must be sent');
        assert.equal(h.initStartPosition, true);
        h.destroy();
    });

    it('calibrateOnStart:true (default) still calibrates', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        a.context.blindPosition = 65;
        const h = new OwnBlindAccessory(p as unknown as P, a as unknown as A,
            { id: 31, name: 'test', time: 20 }); // calibrateOnStart defaults to true
        p.sendCommandSpy.calls.length = 0;
        h.updateStatus();
        const cmds = p.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.some((c: string) => c === '*2*2*31##'), 'move-down must be sent for calibration');
        h.destroy();
    });

    it('position is cached in context on STOP', () => {
        handler.position = 72;
        handler.onData('*2*0*23##');
        assert.equal(accessory.context.blindPosition, 72, 'position must be saved to context on STOP');
    });

    it('position is cached in context on STOP (not on mid-movement ticks)', () => {
        handler.state = POSITION_STATE.INCREASING;
        handler.position = 50;
        handler.target = 80;
        // Before STOP: evaluatePosition tick should NOT write to cache
        accessory.context.blindPosition = 0;
        handler.evaluatePosition();
        assert.equal(accessory.context.blindPosition, 0, 'cache must NOT be updated on mid-movement tick');
        // STOP packet: cache must be written (position far from target → no snap)
        handler.position = 60;
        handler.onData('*2*0*23##');
        assert.equal(accessory.context.blindPosition, 60, 'position must be cached on STOP');
        handler.destroy();
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
        assert.ok(!cmds.some((c: string) => c.startsWith('*2*0*')), 'stop command must not be sent during init phase by evaluatePosition');
        handler.destroy();
    });

    it('onData STOP clears _initPhase when was DECREASING', () => {
        handler.initPhase = true;
        handler.state = POSITION_STATE.DECREASING;
        handler.onData('*2*0*23##');
        assert.equal(handler.initPhase, false);
    });

    it('onData STOP does not clear initPhase when state was STOPPED and position > 0 (gateway broadcast before DECREASING echo)', () => {
        handler.initPhase = true;
        handler.state = POSITION_STATE.STOPPED;
        handler.position = 50; // position > 0: calibration not complete yet
        handler.onData('*2*0*23##');
        assert.equal(handler.initPhase, true, 'initPhase must survive a state broadcast before DECREASING echo');
    });

    it('onData STOP clears initPhase when position=0 (blind already at bottom at startup)', () => {
        handler.initPhase = true;
        handler.state = POSITION_STATE.STOPPED;
        handler.position = 0;
        handler.onData('*2*0*23##');
        assert.equal(handler.initPhase, false, 'initPhase must clear when blind is already at bottom');
    });

    it('physical STOP syncs TargetPosition to CurrentPosition', () => {
        const svc = accessory.services['WindowCovering'];
        handler.state = POSITION_STATE.INCREASING;
        handler.homeKitMovement = false;
        handler.position = 60;
        handler.target = 100;
        handler.onData('*2*0*23##');
        assert.equal(handler.target, 60, 'target must match position after physical stop');
        assert.equal(svc.characteristics['TargetPosition'].value, 60, 'TargetPosition characteristic must be pushed to HomeKit');
    });

    it('full manual operation flow: wall switch UP → tracking → wall switch STOP → HomeKit sync', () => {
        const svc = accessory.services['WindowCovering'];
        handler.position = 50;
        handler.target = 50;
        handler.state = POSITION_STATE.STOPPED;

        // 1. User presses wall UP button — gateway broadcasts INCREASING
        handler.onData('*2*1*23##');
        assert.equal(handler.state, POSITION_STATE.INCREASING, 'state must reflect physical UP');
        assert.equal(handler.homeKitMovement, false, 'homeKitMovement must remain false during physical movement');
        assert.equal(svc.characteristics['CurrentPosition'].value, 51, 'position must increment one tick on first onData');
        assert.notEqual(handler.positionTimeout, undefined, 'position tracking must start');

        // 2. Tick a few times manually
        handler.evaluatePosition();
        handler.evaluatePosition();
        assert.equal(handler.position, 53, 'ticks must advance position during physical movement');

        // 3. User presses wall STOP button — gateway broadcasts STOP
        handler.onData('*2*0*23##');
        assert.equal(handler.state, POSITION_STATE.STOPPED);
        assert.equal(handler.target, 53, 'target must be synced to physical position');
        assert.equal(svc.characteristics['TargetPosition'].value, 53, 'HomeKit TargetPosition must reflect new position');
        assert.equal(svc.characteristics['CurrentPosition'].value, 53);
        assert.equal(svc.characteristics['PositionState'].value, POSITION_STATE.STOPPED);
        assert.equal(accessory.context.blindPosition, 53, 'position must be cached on physical STOP');
    });

    it('successive manual operations after STOP all reflect in HomeKit (regression test)', (_t, done) => {
        // Bug: positionTimeout was cleared but never reset to undefined in evaluatePosition().
        // After the first physical STOP, the variable kept its (cancelled) reference, so the
        // onData guard `!this.positionTimeout` was false, blocking subsequent evaluatePosition() calls.
        const svc = accessory.services['WindowCovering'];
        handler.position = 50;
        handler.target = 50;
        handler.state = POSITION_STATE.STOPPED;

        // 1st manual cycle: UP → STOP
        handler.onData('*2*1*23##');
        handler.onData('*2*0*23##');
        assert.equal(handler.state, POSITION_STATE.STOPPED);
        assert.equal(handler.positionTimeout, undefined, 'positionTimeout must be undefined after STOP');

        // Wait past the post-STOP spurious-packet grace window (150ms)
        setTimeout(() => {
            // 2nd manual cycle: DOWN — must update HomeKit state
            handler.onData('*2*2*23##');
            assert.equal(handler.state, POSITION_STATE.DECREASING, '2nd manual movement state must be reflected');
            assert.equal(svc.characteristics['PositionState'].value, POSITION_STATE.DECREASING,
                '2nd movement PositionState must be pushed to HomeKit');

            // 2nd STOP
            handler.onData('*2*0*23##');
            assert.equal(handler.state, POSITION_STATE.STOPPED, '2nd STOP must be reflected');

            setTimeout(() => {
                // 3rd manual cycle: UP again — must still update HomeKit
                handler.onData('*2*1*23##');
                assert.equal(handler.state, POSITION_STATE.INCREASING, '3rd manual movement state must be reflected');
                assert.equal(svc.characteristics['PositionState'].value, POSITION_STATE.INCREASING);
                done();
            }, 200);
        }, 200);
    });

    it('post-STOP spurious direction packet (BTicino F454) is suppressed', () => {
        // F454 broadcasts *2*2* (DECREASING) immediately after a wall-switch STOP, which
        // would otherwise be mis-interpreted as a new DOWN movement. The plugin must ignore
        // this packet when received within ~150ms of the STOP and position == target.
        const svc = accessory.services['WindowCovering'];
        handler.position = 34;
        handler.target = 34;
        handler.state = POSITION_STATE.STOPPED;

        // Simulate the exact F454 sequence observed in field logs:
        //   *2*0* (STOP) → *2*2* (spurious, immediately after)
        handler.onData('*2*0*23##');
        const stateAfterStop = handler.state;
        handler.onData('*2*2*23##'); // spurious — must be ignored

        assert.equal(handler.state, stateAfterStop, 'state must remain STOPPED, not DECREASING');
        assert.equal(svc.characteristics['PositionState'].value, POSITION_STATE.STOPPED,
            'PositionState must remain STOPPED in HomeKit despite spurious packet');
    });

    it('STOPPED during HomeKit movement does NOT overwrite target', () => {
        handler.state = POSITION_STATE.STOPPED;
        handler.homeKitMovement = true;
        handler.position = 65;
        handler.target = 50;
        handler.evaluatePosition();
        assert.equal(handler.target, 50, 'target must be preserved while homeKitMovement is true');
    });

    it('init STOP timer fires moveStop after travel time', (_t, done) => {
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        handler.time = 0.05;  // 50ms travel + 1000ms margin → ~1050ms
        handler.updateStatus();
        // Verify init DOWN was sent immediately
        const downSent = spy.calls.some((c: unknown[]) => (c[0] as { command: string }).command === '*2*2*23##');
        assert.ok(downSent, 'init DOWN must be sent immediately');
        // Wait for the calibration timer to fire
        setTimeout(() => {
            const stopSent = spy.calls.some((c: unknown[]) => (c[0] as { command: string }).command === '*2*0*23##');
            assert.ok(stopSent, 'init STOP must be sent after travel time + margin');
            handler.destroy();
            done();
        }, 1200);
    });

    it('init STOP timer fires even when gateway sends a premature STOP during calibration', (_t, done) => {
        // Bug fix: endCalibration() previously cleared the safety timer, so a premature
        // gateway STOP (e.g. blind already at bottom) prevented the final STOP from
        // being sent. Now endCalibration() leaves the timer alone — a duplicate STOP
        // at the end of the travel window is harmless.
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        handler.time = 0.05;
        handler.updateStatus();
        spy.calls.length = 0;  // ignore the init DOWN
        // Simulate gateway sending a premature STOP (blind already at bottom)
        handler.onData('*2*0*23##');
        assert.equal(handler.initPhase, false, 'initPhase must be cleared by premature STOP');
        // The safety timer must still fire and send STOP
        setTimeout(() => {
            const stopSent = spy.calls.some((c: unknown[]) => (c[0] as { command: string }).command === '*2*0*23##');
            assert.ok(stopSent, 'safety STOP must be sent after travel time even after premature STOP');
            handler.destroy();
            done();
        }, 1200);
    });

    it('init STOP timer accounts for timeSlat (venetian blinds)', (_t, done) => {
        const spy = platform.sendCommandSpy;
        spy.calls.length = 0;
        handler.time = 0.05;       // 50ms linear
        handler.timeSlat = 0.3;    // 300ms slat → total 350ms + 1000ms margin = 1350ms
        handler.updateStatus();
        // At 1100ms, STOP must NOT yet be sent (linear timer would have fired at 1050ms)
        setTimeout(() => {
            const stopSentEarly = spy.calls.some((c: unknown[]) => (c[0] as { command: string }).command === '*2*0*23##');
            assert.ok(!stopSentEarly, 'STOP must NOT fire before time+timeSlat elapsed');
        }, 1100);
        // After 1500ms, STOP must have fired
        setTimeout(() => {
            const stopSent = spy.calls.some((c: unknown[]) => (c[0] as { command: string }).command === '*2*0*23##');
            assert.ok(stopSent, 'STOP must fire after (time+timeSlat) + margin');
            handler.destroy();
            done();
        }, 1500);
    });

    it('stopMoveTracking clears initPhase to unblock subsequent stops', () => {
        handler.initPhase = true;
        handler.stopMoveTracking();
        assert.equal(handler.initPhase, false, 'initPhase must be cleared so future moves can stop at target');
    });

    it('init timer clears initPhase before moveStop (gateway STOP echo may not clear it)', (_t, done) => {
        handler.time = 0.05;
        handler.updateStatus();
        // Wait for the calibration timer to fire
        setTimeout(() => {
            assert.equal(handler.initPhase, false, 'initPhase must be cleared by init timer to unblock future DECREASING stops');
            handler.destroy();
            done();
        }, 1200);
    });

    it('STOPPED during status query does NOT overwrite target', () => {
        const svc = accessory.services['WindowCovering'];
        handler.state = POSITION_STATE.STOPPED;
        handler.homeKitMovement = false;
        (handler as unknown as { inStatusQuery: boolean }).inStatusQuery = true;
        handler.position = 75;
        handler.target = 50;
        svc.characteristics['TargetPosition'].value = 50;
        handler.evaluatePosition();
        assert.equal(handler.target, 50, 'target must be preserved during status query');
        assert.equal(svc.characteristics['TargetPosition'].value, 50, 'TargetPosition must not be pushed during status query');
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

    it('evaluatePosition physical UP stops tracking at upper end-stop (pos=100)', () => {
        handler.homeKitMovement = false;
        handler.state = POSITION_STATE.INCREASING;
        handler.position = 100;
        handler.evaluatePosition();
        assert.equal(handler.positionTimeout, undefined, 'must not reschedule at upper end-stop');
    });

    it('evaluatePosition physical DOWN stops tracking at lower end-stop (pos=0)', () => {
        handler.homeKitMovement = false;
        handler.state = POSITION_STATE.DECREASING;
        handler.position = 0;
        handler.target = 0;
        handler.evaluatePosition();
        assert.equal(handler.positionTimeout, undefined, 'must not reschedule at lower end-stop');
    });

    it('status query response does not trigger physical override on monitor path', () => {
        // Bug: inStatusQuery was only set inside packet callback (command path).
        // Monitor receives echoed status packets WITHOUT the flag → false physical override.
        // Fix: inStatusQuery is now set BEFORE sendCommand and cleared in done callback.
        handler.homeKitMovement = true;
        handler.expectedState = POSITION_STATE.INCREASING;
        handler.state = POSITION_STATE.INCREASING;  // forced by endTimerCommand timeout
        handler.initStartPosition = true;  // skip init path

        handler.updateStatus();  // sets inStatusQuery=true, then calls sendCommand

        // Flag must be true while the query is in flight (monitor path protection)
        assert.equal((handler as unknown as Record<string, unknown>)['inStatusQuery'], true,
            'inStatusQuery must be true from the moment updateStatus sends the query');

        // Simulate monitor receiving STOPPED echo (the bug scenario)
        handler.onData('*2*0*23##');

        // homeKitMovement must survive — no physical override during query window
        assert.equal(handler.homeKitMovement, true,
            'homeKitMovement must survive status query STOP echo on monitor path');

        // Simulate done callback (command connection closes)
        const lastCall = platform.sendCommandSpy.calls[platform.sendCommandSpy.calls.length - 1];
        const params = lastCall[0] as Record<string, unknown>;
        if (typeof params['done'] === 'function') {
            (params['done'] as (p: null, i: number) => void)(null, -1);
        }
        assert.equal((handler as unknown as Record<string, unknown>)['inStatusQuery'], false,
            'inStatusQuery must be cleared after done callback');
    });

    it('STOP packet from gateway during HomeKit movement triggers physical override (real stop)', () => {
        // *2*0*<id>## from the gateway always means a real stop (physical button, end-stop, obstacle).
        // It must NOT be ignored — the override must fire so the blind syncs target=position to HomeKit.
        handler.homeKitMovement = true;
        handler.expectedState = POSITION_STATE.INCREASING;
        handler.state = POSITION_STATE.INCREASING;
        handler.position = 50;
        handler.target = 80;
        handler.onData('*2*0*23##');
        assert.equal(handler.homeKitMovement, false, 'physical override must cancel HomeKit movement on real STOP');
    });

    it('physical override fires for genuine direction reversal (INCREASING→DECREASING)', () => {
        handler.homeKitMovement = true;
        handler.expectedState = POSITION_STATE.INCREASING;
        handler.state = POSITION_STATE.INCREASING;
        handler.position = 50;
        handler.target = 80;

        handler.onData('*2*2*23##');  // physical DOWN while HomeKit was going UP

        assert.equal(handler.homeKitMovement, false, 'homeKitMovement must be cleared on real physical override');
        assert.equal(handler.state, POSITION_STATE.DECREASING);
    });

    it('evaluatePosition during init stops rescheduling when position reaches 0', () => {
        handler.initPhase = true;
        handler.state = POSITION_STATE.DECREASING;
        handler.position = 0;
        handler.target = 0;
        handler.evaluatePosition();
        assert.equal(handler.positionTimeout, undefined);
    });

    it('move() with pending command increments moveRetries and schedules retry', () => {
        handler.commandSent = true;
        handler.moveRetries = 5;
        handler.target = 80;
        handler.position = 20;
        handler.move();
        assert.equal(handler.moveRetries, 6, 'moveRetries must increment on each pending-command retry');
        assert.notEqual(handler.moveTrackingTimeout, undefined);
        handler.destroy();
    });

    it('move() with pending command gives up after BLIND_MAX_MOVE_RETRIES', () => {
        handler.commandSent = true;
        handler.moveRetries = 30; // at the limit
        handler.target = 80;
        handler.position = 20;
        handler.move();
        assert.equal(handler.moveTrackingTimeout, undefined, 'retry loop must be stopped after max retries');
        assert.equal(handler.commandSent, false, 'commandSent must be reset after giving up');
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

    it('move() restores homeKitMovement when already moving in the right direction (rapid retarget)', () => {
        // Simulate: user set target=50 (blind starts UP), then immediately set target=80
        // stopMoveTracking() cleared homeKitMovement; move() should restore it
        handler.state = POSITION_STATE.INCREASING;
        handler.homeKitMovement = false; // cleared by stopMoveTracking
        handler.commandSent = false;
        handler.position = 30;
        handler.target = 80;
        // positionTimeout must be undefined (cleared by stopMoveTracking)
        handler.move();
        assert.equal(handler.homeKitMovement, true, 'homeKitMovement must be restored when already moving in right direction');
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

    it('setOnline false sets StatusFault to GENERAL_FAULT', () => {
        const svc = accessory.services['WindowCovering'];
        handler.setOnline(false);
        assert.equal(svc.characteristics['StatusFault'].value, 1);
    });

    it('setOnline true clears StatusFault to NO_FAULT', () => {
        const svc = accessory.services['WindowCovering'];
        handler.setOnline(false);
        handler.setOnline(true);
        assert.equal(svc.characteristics['StatusFault'].value, 0);
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

    it('asButton: true creates StatelessProgrammableSwitch and removes Switch', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        a.addService('Switch'); // simulate previous run with asButton=false
        const h = new OwnScenarioAccessory(p as unknown as P, a as unknown as A, { id: 7, name: 'btn', asButton: true });
        assert.ok(a.services['StatelessProgrammableSwitch'], 'StatelessProgrammableSwitch must be created');
        assert.ok(!a.services['Switch'], 'old Switch must be removed');
        h.destroy();
    });

    it('asButton: true activate fires SINGLE_PRESS event and sends scenario command', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        const h = new OwnScenarioAccessory(p as unknown as P, a as unknown as A, { id: 11, name: 'btn', asButton: true });
        const svc = a.services['StatelessProgrammableSwitch'];
        p.sendCommandSpy.calls.length = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (h as any).activate();
        const cmds = p.sendCommandSpy.calls.map((c: unknown[]) => (c[0] as { command: string }).command);
        assert.ok(cmds.includes('*0*11*0##'));
        assert.equal(svc.characteristics['ProgrammableSwitchEvent'].value, 0);
        h.destroy();
    });

    it('asButton: false (legacy) flip removes any pre-existing StatelessProgrammableSwitch', () => {
        const p = makeMockPlatform();
        const a = makeMockAccessory();
        a.addService('AccessoryInformation');
        a.addService('StatelessProgrammableSwitch');
        const h = new OwnScenarioAccessory(p as unknown as P, a as unknown as A, { id: 13, name: 'sw' });
        assert.ok(a.services['Switch'], 'Switch must be created in legacy mode');
        assert.ok(!a.services['StatelessProgrammableSwitch'], 'old StatelessProgrammableSwitch must be removed');
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
