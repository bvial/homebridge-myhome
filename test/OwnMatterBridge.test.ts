import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { API, Logging, MatterAccessory, PlatformAccessory } from 'homebridge';
import { OwnMatterBridge, type MatterDeviceEntry } from '../lib/OwnMatterBridge';
import type { DeviceCommand, DeviceEvent, DeviceKind, DeviceState, OwnDevice } from '../lib/OwnDevice';
import { OwnLightAccessory, type OwnPlatformLike } from '../lib/OwnAccessory';
import { makeMockPlatform, makeMockAccessory, makeMockClient } from './helpers';
import { PKT } from '../lib/OwnNet';

class ProtocolError extends Error {}
class Busy extends ProtocolError {}
class Timeout extends ProtocolError {}
class InvalidInState extends ProtocolError {}
class InvalidAction extends ProtocolError {}
class Failure extends ProtocolError {}
class ConstraintError extends ProtocolError {}
class LevelBehavior { static id = 'levelControl'; }
type Behavior = Record<string, (...args: unknown[]) => void | Promise<void>>;
type BehaviorType = { new(): Behavior; id: string };

class DeviceType {
    behaviors: Record<string, unknown> = { levelControl: LevelBehavior };
    constructor(readonly name: string, readonly features: unknown[] = []) {}
    with(...features: unknown[]): DeviceType {
        const type = new DeviceType(this.name, features);
        for (const feature of features) {
            if (typeof feature === 'function') type.behaviors[(feature as unknown as BehaviorType).id] = feature;
        }
        return type;
    }
}

class Device implements OwnDevice {
    state: DeviceState = { name: 'MyHome', online: true };
    commands: DeviceCommand[] = [];
    listeners = new Set<(event: DeviceEvent) => void>();
    behavior?: (command: DeviceCommand) => void | Promise<void>;
    snapshot(): DeviceState { return { ...this.state }; }
    execute(command: DeviceCommand): void | Promise<void> {
        this.commands.push(command);
        if (this.behavior) return this.behavior(command);
        switch (command.type) {
            case 'power': this.change({ on: command.value }); break;
            case 'brightness': this.change({ brightness: command.value, on: command.value > 0 }); break;
            case 'position': this.change({ targetPosition: command.value }); break;
            case 'temperature': this.change({ targetTemperature: command.value }); break;
            case 'mode': this.change({ mode: command.value }); break;
            case 'activate': this.change({ on: true }); break;
            case 'unlock': this.change({ locked: false }); break;
            case 'stop': this.change({ moving: 'stopped', targetPosition: this.state.position }); break;
        }
    }
    subscribe(listener: (event: DeviceEvent) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    emit(event: DeviceEvent): void { for (const listener of this.listeners) listener(event); }
    change(state: Partial<DeviceState>): void { this.state = { ...this.state, ...state }; this.emit({ type: 'state', state: this.snapshot() }); }
}

type Update = { UUID: string; cluster: string; state: Record<string, unknown>; partId?: string };
function fixture() {
    const registered: MatterAccessory[] = [];
    const removed: MatterAccessory[] = [];
    const persisted: MatterAccessory[] = [];
    const updates: Update[] = [];
    const events: { UUID: string; action: string; partId?: string }[] = [];
    const hooks: { register?: () => Promise<void>; unregister?: () => Promise<void>; update?: (update: Update) => Promise<void> } = {};
    const deviceTypes = Object.fromEntries([
        'OnOffOutlet', 'OnOffLight', 'DimmableLight', 'WindowCovering', 'Thermostat',
        'MotionSensor', 'LeakSensor', 'SmokeSensor', 'ContactSensor', 'ElectricalSensor', 'DoorLock', 'GenericSwitch',
    ].map(name => [name, new DeviceType(name)]));
    const api = { matter: {
        deviceTypes,
        deviceRequirements: {
            Thermostat: { ThermostatServer: new DeviceType('ThermostatServer') },
            MotionSensor: { OccupancySensingServer: new DeviceType('OccupancySensingServer') },
        },
        status: { Busy, Timeout, InvalidInState, InvalidAction, Failure, ConstraintError, isMatterProtocolError: (error: unknown) => error instanceof ProtocolError },
        registerPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => { registered.push(...accessories); await hooks.register?.(); },
        unregisterPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => { await hooks.unregister?.(); removed.push(...accessories); },
        updatePlatformAccessories: async (accessories: MatterAccessory[]) => { persisted.push(...accessories); },
        updateAccessoryState: async (UUID: string, cluster: string, state: Record<string, unknown>, partId?: string) => {
            await hooks.update?.({ UUID, cluster, state, partId }); updates.push({ UUID, cluster, state, partId });
        },
        switch: { emit: async (UUID: string, action: string, options?: { partId?: string }) => { events.push({ UUID, action, partId: options?.partId }); } },
    } };
    const log = { error: () => {}, warn: () => {} } as unknown as Logging;
    const bridge = new OwnMatterBridge(api as unknown as API, log);
    const entry = (kind: DeviceKind, config: Record<string, unknown> = {}, state: Partial<DeviceState> = {}, UUID: string = kind): MatterDeviceEntry & { device: Device } => {
        const device = new Device();
        Object.assign(device.state, state);
        return { UUID, kind, config, device, context: { type: kind, device: config } };
    };
    return { bridge, entry, registered, removed, persisted, updates, events, hooks };
}

function command(accessory: MatterAccessory, cluster: string, name: string, args?: unknown, partId?: string): Promise<void> {
    return Promise.resolve().then(() => {
        const target = partId ? accessory.parts?.find(part => part.id === partId) : accessory;
        if (cluster === 'levelControl') {
            const Base = (target?.deviceType as unknown as DeviceType).behaviors.levelControl as BehaviorType;
            const behavior = new Base();
            const values = args as Record<string, unknown> | undefined;
            const withOnOff = name.endsWith('WithOnOff');
            if (name === 'stopWithOnOff') return behavior.stopWithOnOff();
            if (name.startsWith('moveToLevel')) return behavior.moveToLevelLogic(values?.level, null, withOnOff);
            if (name.startsWith('step')) return behavior.stepLogic(values?.stepMode, values?.stepSize, null, withOnOff);
            if (name.startsWith('move')) return behavior.moveLogic(values?.moveMode, values?.rate, withOnOff);
            if (name.startsWith('stop')) return behavior.stopLogic();
            assert.fail(`Missing level command ${name}`);
        }
        const handlers = target?.handlers as unknown as Record<string, Record<string, (args?: unknown) => void | Promise<void>>>;
        assert.equal(typeof handlers?.[cluster]?.[name], 'function', `Missing ${partId ?? ''}/${cluster}.${name}`);
        return handlers[cluster][name](args);
    });
}

async function settle(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
}

function gate(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe('OwnMatterBridge mappings', () => {
    it('converts dimmer units, forwards each command once and defers synchronous state changes', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light', { dimmer: true }, { on: true, brightness: 50 });
        await f.bridge.sync([light]);
        await settle();
        const accessory = f.registered[0];
        assert.equal((accessory.deviceType as unknown as DeviceType).name, 'DimmableLight');
        assert.equal(accessory.clusters?.levelControl?.currentLevel, 127);
        const before = f.updates.length;
        await command(accessory, 'levelControl', 'moveToLevelWithOnOff', { level: 254 });
        assert.deepEqual(light.device.commands, [{ type: 'brightness', value: 100 }]);
        assert.equal(f.updates.length, before, 'no endpoint write during the command transaction');
        await settle();
        assert.equal(f.updates.filter(update => update.cluster === 'levelControl').slice(-1)[0]?.state.currentLevel, 254);
        await command(accessory, 'levelControl', 'moveToLevelWithOnOff', { level: 0 });
        await command(accessory, 'onOff', 'toggle');
        assert.deepEqual(light.device.commands.slice(-2), [{ type: 'brightness', value: 0 }, { type: 'power', value: true }]);
        await assert.rejects(command(accessory, 'levelControl', 'moveToLevel', { level: 255 }), ConstraintError);
        await assert.rejects(command(accessory, 'levelControl', 'step', { stepMode: 0.5, stepSize: 10 }), ConstraintError);
    });

    it('converts shutter percent-open to Matter percent-closed and supports stop', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const blind = f.entry('blind', {}, { position: 75, targetPosition: 100, moving: 'opening' });
        await f.bridge.sync([blind]);
        const accessory = f.registered[0];
        assert.equal(accessory.clusters?.windowCovering?.currentPositionLiftPercent100ths, 2500);
        assert.equal(accessory.clusters?.windowCovering?.targetPositionLiftPercent100ths, 0);
        assert.deepEqual(accessory.clusters?.windowCovering?.operationalStatus, { global: 1, lift: 1, tilt: 0 });
        await command(accessory, 'windowCovering', 'upOrOpen');
        await command(accessory, 'windowCovering', 'downOrClose');
        await command(accessory, 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 3200 });
        await command(accessory, 'windowCovering', 'stopMotion');
        assert.deepEqual(blind.device.commands, [
            { type: 'position', value: 100 }, { type: 'position', value: 0 },
            { type: 'position', value: 68 }, { type: 'stop' },
        ]);
    });

    it('keeps light power unchanged for level commands without OnOff', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light', { dimmer: true }, { on: false, brightness: 50 });
        await f.bridge.sync([light]);
        const accessory = f.registered[0];
        await command(accessory, 'levelControl', 'moveToLevel', { level: 200 });
        await command(accessory, 'levelControl', 'move', { moveMode: 0, rate: 100 });
        await command(accessory, 'levelControl', 'step', { stepMode: 0, stepSize: 20 });
        assert.equal(light.device.commands.length, 0);
        await command(accessory, 'levelControl', 'moveToLevelWithOnOff', { level: 200 });
        assert.equal(light.device.snapshot().on, true);
        await command(accessory, 'levelControl', 'moveToLevel', { level: 0 });
        assert.equal(light.device.snapshot().on, true);
        await command(accessory, 'levelControl', 'moveToLevelWithOnOff', { level: 1 });
        assert.equal(light.device.snapshot().on, false);
    });

    it('represents scheduled thermostat mode with a programme part, without Matter AutoMode', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const thermostat = f.entry('thermostat', {}, { mode: 'auto', activeMode: 'heat', temperature: 21.25, targetTemperature: 22 });
        await f.bridge.sync([thermostat]);
        const accessory = f.registered[0];
        const features = (accessory.deviceType as unknown as DeviceType).features as DeviceType[];
        assert.deepEqual(features[0].features, ['Heating']);
        assert.equal(accessory.clusters?.thermostat?.localTemperature, 2125);
        assert.equal(accessory.clusters?.thermostat?.occupiedHeatingSetpoint, 2200);
        assert.equal(accessory.clusters?.thermostat?.thermostatRunningMode, undefined);
        assert.deepEqual((accessory.clusters?.thermostat as Record<string, unknown>).thermostatRunningState, { heat: true, cool: false });
        assert.equal(accessory.parts?.[0].clusters?.onOff?.onOff, true);
        await assert.rejects(command(accessory, 'thermostat', 'systemModeChange', { systemMode: 1 }), InvalidAction);
        await assert.rejects(command(accessory, 'thermostat', 'occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2300 }), InvalidInState);
        await command(accessory, 'onOff', 'off', undefined, 'programme');
        await command(accessory, 'thermostat', 'occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2300 });
        await command(accessory, 'thermostat', 'setpointRaiseLower', { mode: 0, amount: 10 });
        await command(accessory, 'onOff', 'on', undefined, 'programme');
        assert.deepEqual(thermostat.device.commands, [
            { type: 'mode', value: 'heat' }, { type: 'temperature', value: 23 },
            { type: 'temperature', value: 24 }, { type: 'mode', value: 'auto' },
        ]);
    });

    it('restricts setpoints to configured manual capabilities and remembers cooling for programmes', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const thermostat = f.entry('thermostat', { matterMode: 'both' }, { mode: 'cool', activeMode: 'cool', targetTemperature: 24 });
        await f.bridge.sync([thermostat]);
        await settle();
        const accessory = f.registered[0];
        assert.deepEqual(((accessory.deviceType as unknown as DeviceType).features as DeviceType[])[0].features, ['Heating', 'Cooling']);
        await assert.rejects(command(accessory, 'thermostat', 'occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2300 }), InvalidInState);
        await command(accessory, 'thermostat', 'occupiedCoolingSetpointChange', { occupiedCoolingSetpoint: 2350 });
        await command(accessory, 'onOff', 'on', undefined, 'programme');
        await command(accessory, 'onOff', 'off', undefined, 'programme');
        assert.deepEqual(thermostat.device.commands.slice(-1)[0], { type: 'mode', value: 'cool' });
        await command(accessory, 'thermostat', 'systemModeChange', { systemMode: 4 });
        await command(accessory, 'onOff', 'on', undefined, 'programme');
        await command(accessory, 'onOff', 'off', undefined, 'programme');
        assert.deepEqual(thermostat.device.commands.slice(-1)[0], { type: 'mode', value: 'heat' });
        const coolingOnly = f.entry('thermostat', { matterMode: 'cool' }, { mode: 'cool' }, 'cooling-only');
        await f.bridge.sync([thermostat, coolingOnly]);
        const cooling = f.registered[1];
        assert.equal(cooling.handlers?.thermostat?.occupiedHeatingSetpointChange, undefined);
        await assert.rejects(command(cooling, 'thermostat', 'systemModeChange', { systemMode: 4 }), InvalidAction);
    });

    it('keeps an already disabled programme off and avoids duplicate raise/lower commands', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const thermostat = f.entry('thermostat', { matterMode: 'both' }, { mode: 'off', targetTemperature: 21 });
        await f.bridge.sync([thermostat]);
        const accessory = f.registered[0];
        await command(accessory, 'onOff', 'off', undefined, 'programme');
        assert.equal(thermostat.device.commands.length, 0);
        assert.equal(thermostat.device.snapshot().mode, 'off');
        thermostat.device.change({ mode: 'heat' });
        await command(accessory, 'onOff', 'off', undefined, 'programme');
        assert.equal(thermostat.device.commands.length, 0);
        await command(accessory, 'thermostat', 'setpointRaiseLower', { mode: 2, amount: 10 });
        // Matter itself emits these attribute callbacks after the command.
        await command(accessory, 'thermostat', 'occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2200 });
        await command(accessory, 'thermostat', 'occupiedCoolingSetpointChange', { occupiedCoolingSetpoint: 2200 });
        assert.deepEqual(thermostat.device.commands, [{ type: 'temperature', value: 22 }]);
    });

    it('uses contact polarity, occupancy and alarm states appropriate to each sensor', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const kinds = ['contact', 'motion', 'occupancy', 'leak', 'smoke', 'co'];
        const entries = kinds.map(sensorType => f.entry('contact', { sensorType }, { triggered: true }, sensorType));
        await f.bridge.sync(entries);
        const [contact, motion, occupancy, leak, smoke, co] = f.registered;
        assert.equal(contact.clusters?.booleanState?.stateValue, false);
        assert.equal(leak.clusters?.booleanState?.stateValue, true);
        assert.deepEqual(motion.clusters?.occupancySensing?.occupancy, { occupied: true });
        assert.deepEqual(occupancy.clusters?.occupancySensing?.occupancy, { occupied: true });
        assert.deepEqual(((occupancy.deviceType as unknown as DeviceType).features as DeviceType[])[0].features, ['PhysicalContact', 'OccupancyEvent']);
        assert.equal(smoke.clusters?.smokeCoAlarm?.smokeState, 2);
        assert.equal(co.clusters?.smokeCoAlarm?.coState, 2);
        assert.equal(co.clusters?.carbonMonoxideConcentrationMeasurement, undefined);
        entries[0].device.change({ triggered: false });
        await settle();
        assert.equal(f.updates.filter(update => update.UUID === 'contact' && update.cluster === 'booleanState').slice(-1)[0]?.state.stateValue, true);
    });

    it('exposes power in milliwatts, momentary scenarios and doorbell events without inventing capabilities', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const energy = f.entry('energy', {}, { watts: 237.5 });
        const scenario = f.entry('scenario', {}, { on: false });
        const door = f.entry('door', { doorbell: true }, { locked: true });
        await f.bridge.sync([energy, scenario, door]);
        const [meter, button, lock] = f.registered;
        assert.equal(meter.clusters?.electricalPowerMeasurement?.activePower, 237500);
        assert.equal(meter.clusters?.electricalEnergyMeasurement, undefined);
        assert.equal((button.deviceType as unknown as DeviceType).name, 'OnOffOutlet');
        await command(button, 'onOff', 'on');
        await settle();
        scenario.device.change({ on: false });
        await settle();
        assert.equal(f.updates.filter(update => update.UUID === 'scenario' && update.cluster === 'onOff').slice(-1)[0]?.state.onOff, false);
        await command(lock, 'doorLock', 'unlockDoor');
        await assert.rejects(command(lock, 'doorLock', 'lockDoor'), InvalidAction);
        assert.deepEqual(door.device.commands, [{ type: 'unlock' }]);
        door.device.emit({ type: 'doorbell' });
        door.device.emit({ type: 'doorbell' });
        await settle();
        assert.deepEqual(f.events, [
            { UUID: 'door', action: 'press', partId: 'doorbell' }, { UUID: 'door', action: 'release', partId: 'doorbell' },
            { UUID: 'door', action: 'press', partId: 'doorbell' }, { UUID: 'door', action: 'release', partId: 'doorbell' },
        ]);
    });
});

describe('OwnMatterBridge lifecycle', () => {
    it('preserves cached cooling when rebuilding a thermostat before the gateway reports its mode', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const thermostat = f.entry('thermostat', { matterMode: 'both' }, { mode: 'cool', targetTemperature: 24 });
        await f.bridge.sync([thermostat]);
        thermostat.device.change({ mode: 'auto', activeMode: 'off' });
        await settle();
        const cached = { ...f.registered[0], context: JSON.parse(JSON.stringify(f.registered[0].context)) };
        assert.equal(cached.context.manualMode, 'cool');
        f.bridge.destroy();

        const restored = fixture(); t.after(() => restored.bridge.destroy());
        const device = restored.entry('thermostat', { matterMode: 'both' }, { mode: 'off', targetTemperature: 24 });
        restored.bridge.configureAccessory(cached);
        await restored.bridge.sync([device]);
        assert.equal(restored.removed.length, 1, 'the composed endpoint must still be rebuilt');
        assert.equal(restored.registered[0].context?.manualMode, 'cool');
        device.device.change({ mode: 'auto', activeMode: 'off' });
        await settle();
        await command(restored.registered[0], 'onOff', 'off', undefined, 'programme');
        assert.deepEqual(device.device.commands, [{ type: 'mode', value: 'cool' }]);
    });

    it('retains the manual mode when a live thermostat controller is replaced', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const first = f.entry('thermostat', { matterMode: 'both' }, { mode: 'cool' });
        await f.bridge.sync([first]);
        first.device.change({ mode: 'auto', activeMode: 'off' });
        const replacement = f.entry('thermostat', { matterMode: 'both' }, { mode: 'auto', activeMode: 'off' });
        await f.bridge.sync([replacement]);
        await command(f.registered[1], 'onOff', 'off', undefined, 'programme');
        assert.deepEqual(replacement.device.commands, [{ type: 'mode', value: 'cool' }]);
    });

    for (const origin of ['cached', 'live'] as const) {
        it(`retains cooling through repeated registration failures when replacing a ${origin} thermostat`, async t => {
            const initial = fixture(); t.after(() => initial.bridge.destroy());
            const first = initial.entry('thermostat', { matterMode: 'both' }, { mode: 'cool', targetTemperature: 24 });
            await initial.bridge.sync([first]);
            first.device.change({ mode: 'auto', activeMode: 'off' });
            await settle();
            const f = origin === 'live' ? initial : fixture();
            if (origin === 'cached') {
                t.after(() => f.bridge.destroy());
                f.bridge.configureAccessory({ ...initial.registered[0], context: JSON.parse(JSON.stringify(initial.registered[0].context)) });
                initial.bridge.destroy();
            }
            const replacement = f.entry('thermostat', { matterMode: 'both' }, { mode: 'auto', activeMode: 'off', targetTemperature: 24 });
            f.hooks.register = async () => { throw new Error('temporary registration failure'); };
            await f.bridge.sync([replacement]);
            await f.bridge.sync([replacement]);
            assert.equal(f.removed.length, 1, 'the already removed endpoint must not be unregistered again');
            assert.equal(replacement.device.listeners.size, 0);
            f.hooks.register = undefined;
            await f.bridge.sync([replacement]);
            const accessory = f.registered[f.registered.length - 1];
            assert.equal(accessory.context?.manualMode, 'cool');
            await command(accessory, 'onOff', 'off', undefined, 'programme');
            assert.deepEqual(replacement.device.commands, [{ type: 'mode', value: 'cool' }]);

            replacement.device.change({ mode: 'heat' });
            await settle();
            const next = f.entry('thermostat', { matterMode: 'both' }, { mode: 'auto', activeMode: 'off' });
            await f.bridge.sync([next]);
            await command(f.registered[f.registered.length - 1], 'onOff', 'off', undefined, 'programme');
            assert.deepEqual(next.device.commands, [{ type: 'mode', value: 'heat' }], 'successful live state takes precedence over old retained context');
        });
    }

    it('discards retained context when a failed accessory is removed from the desired devices', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const first = f.entry('thermostat', { matterMode: 'both' }, { mode: 'cool' });
        await f.bridge.sync([first]);
        const replacement = f.entry('thermostat', { matterMode: 'both' }, { mode: 'auto', activeMode: 'off' });
        f.hooks.register = async () => { throw new Error('temporary failure'); };
        await f.bridge.sync([replacement]);
        await f.bridge.sync([]);
        f.hooks.register = undefined;
        const fresh = f.entry('thermostat', { matterMode: 'both' }, { mode: 'auto', activeMode: 'off' });
        await f.bridge.sync([fresh]);
        const accessory = f.registered[f.registered.length - 1];
        assert.equal(accessory.context?.manualMode, 'heat');
        await command(accessory, 'onOff', 'off', undefined, 'programme');
        assert.deepEqual(fresh.device.commands, [{ type: 'mode', value: 'heat' }]);
    });

    for (const variant of ['move', 'moveWithOnOff']) {
        it(`${variant} yields to wall-switch OFF and does not resume on a later ON`, async t => {
            t.mock.timers.enable({ apis: ['setInterval'] });
            const f = fixture(); t.after(() => f.bridge.destroy());
            const light = f.entry('light', { dimmer: true }, { on: true, brightness: 50 });
            await f.bridge.sync([light]);
            await command(f.registered[0], 'levelControl', variant, { moveMode: 0, rate: 100 });
            light.device.change({ on: false });
            t.mock.timers.tick(1000);
            await settle();
            assert.equal(light.device.commands.length, 0);
            light.device.change({ on: true });
            t.mock.timers.tick(1000);
            await settle();
            assert.equal(light.device.commands.length, 0);
        });
    }

    it('cancels dimming as soon as HomeKit queues OFF, including while a brightness ACK is pending', async t => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const f = fixture(); t.after(() => f.bridge.destroy());
        const platform = makeMockPlatform();
        const accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        const { client, connections, sent } = makeMockClient(platform.log);
        const api = { ...platform, controller: client } as unknown as OwnPlatformLike;
        const light = new OwnLightAccessory(api, accessory as unknown as PlatformAccessory, { id: 1, dimmer: true });
        t.after(() => { light.destroy(); client.destroy(); });
        light.onData('*1*5*1##');
        await f.bridge.sync([{ UUID: 'light', kind: 'light', config: { dimmer: true }, context: {}, device: light }]);
        await command(f.registered[0], 'levelControl', 'moveWithOnOff', { moveMode: 0, rate: 100 });
        t.mock.timers.tick(250);
        assert.deepEqual(sent, ['*1*6*1##']);
        const off = accessory.services.Lightbulb.characteristics.On.setter!(false);
        assert.ok(off instanceof Promise);
        connections[0].onData(PKT.ACK);
        await settle();
        assert.deepEqual(sent, ['*1*6*1##', '*1*0*1##']);
        t.mock.timers.tick(1000);
        await settle();
        assert.equal(client.queueSize(), 0, 'no brightness command may be queued behind OFF');
        connections[1].onData(PKT.ACK);
        await off;
        t.mock.timers.tick(1000);
        await settle();
        assert.equal(light.snapshot().on, false);
        assert.equal(sent.length, 2);
    });

    for (const waiting of ['queue', 'handshake'] as const) {
        for (const action of ['wall-off', 'matter-stop', 'destroy'] as const) {
            it(`${action} cancels a dimming tick waiting in the ${waiting}`, async t => {
                t.mock.timers.enable({ apis: ['setInterval'] });
                const f = fixture(); t.after(() => f.bridge.destroy());
                const platform = makeMockPlatform();
                const accessory = makeMockAccessory(); accessory.addService('AccessoryInformation');
                const { client, connections, sent } = makeMockClient(platform.log, waiting !== 'handshake');
                client.maxConcurrent = 1;
                const light = new OwnLightAccessory({ ...platform, controller: client } as unknown as OwnPlatformLike,
                    accessory as unknown as PlatformAccessory, { id: 1, dimmer: true });
                t.after(() => { light.destroy(); client.destroy(); });
                light.onData('*1*5*1##');
                await f.bridge.sync([{ UUID: 'light', kind: 'light', config: { dimmer: true }, context: {}, device: light }]);
                if (waiting === 'queue') client.sendCommand({ command: 'blocker' });
                await command(f.registered[0], 'levelControl', 'moveWithOnOff', { moveMode: 0, rate: 100 });
                t.mock.timers.tick(250);
                if (action === 'wall-off') light.onData('*1*0*1##');
                else if (action === 'matter-stop') await command(f.registered[0], 'levelControl', 'stop');
                else f.bridge.destroy();
                assert.equal(client.queueSize(), 0, 'the old tick must be removed immediately');
                if (waiting === 'queue') connections[0].onData(PKT.ACK);
                else connections[0].emit('connected');
                await settle();
                t.mock.timers.tick(1000); await settle();
                assert.deepEqual(sent, waiting === 'queue' ? ['blocker'] : []);
                assert.equal(light.snapshot().on, action !== 'wall-off');
                assert.equal(light.snapshot().brightness, 50);
            });
        }
    }

    it('returns real gateway NACKs through the Matter command path', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const platform = makeMockPlatform();
        const accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        const { client, connections } = makeMockClient(platform.log);
        const light = new OwnLightAccessory({ ...platform, controller: client } as unknown as OwnPlatformLike,
            accessory as unknown as PlatformAccessory, { id: 1 });
        t.after(() => { light.destroy(); client.destroy(); });
        await f.bridge.sync([{ UUID: 'light', kind: 'light', config: {}, context: {}, device: light }]);
        const result = command(f.registered[0], 'onOff', 'on');
        const rejected = assert.rejects(result, Failure);
        await settle();
        connections[0].onData(PKT.NACK);
        await rejected;
        await settle();
        assert.equal(light.snapshot().on, false);
        assert.equal(f.updates.filter(update => update.cluster === 'onOff').slice(-1)[0]?.state.onOff, false);
    });

    it('keeps UUID serials and UTF-8 names within Matter size limits', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const UUID = 'c0b54b67-89ed-48d5-9060-0f63c48f9487';
        const device = f.entry('thermostat', {}, { name: 'É'.repeat(40), mode: 'heat' }, UUID);
        await f.bridge.sync([device]);
        const accessory = f.registered[0];
        assert.equal(accessory.serialNumber, 'c0b54b6789ed48d590600f63c48f9487');
        assert.equal(accessory.displayName, 'É'.repeat(16));
        assert.ok(Buffer.byteLength(accessory.parts![0].displayName!) <= 64);
        device.device.change({ name: '😀'.repeat(30) });
        await settle();
        assert.equal(accessory.displayName, '😀'.repeat(8));
        assert.equal(f.updates.filter(update => update.cluster === 'bridgedDeviceBasicInformation').slice(-1)[0]?.state.nodeLabel, '😀'.repeat(8));
    });
    it('suppresses thermostat attribute echoes during state publication, including scheduled mode', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const thermostat = f.entry('thermostat', {}, { mode: 'auto', activeMode: 'heat', targetTemperature: 21 });
        f.hooks.update = async update => {
            if (update.cluster !== 'thermostat') return;
            await command(f.registered[0], 'thermostat', 'systemModeChange', { systemMode: update.state.systemMode });
            await command(f.registered[0], 'thermostat', 'occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: update.state.occupiedHeatingSetpoint });
        };
        await f.bridge.sync([thermostat]);
        await settle();
        thermostat.device.change({ targetTemperature: 22 });
        await settle();
        assert.equal(thermostat.device.commands.length, 0, 'publishing bus state must not send commands back');
        assert.equal(f.updates.filter(update => update.cluster === 'thermostat').slice(-1)[0]?.state.occupiedHeatingSetpoint, 2200);
        await assert.rejects(command(f.registered[0], 'thermostat', 'occupiedHeatingSetpointChange', { occupiedHeatingSetpoint: 2300 }), InvalidInState);
    });

    it('reasserts rounded hardware values even if the last reported state was identical', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light', { dimmer: true }, { on: true, brightness: 50 });
        await f.bridge.sync([light]);
        await settle();
        const before = f.updates.filter(update => update.cluster === 'levelControl').length;
        // 128 rounds to hardware 50%, which maps back to Matter level 127.
        await command(f.registered[0], 'levelControl', 'moveToLevelWithOnOff', { level: 128 });
        await settle();
        const updates = f.updates.filter(update => update.cluster === 'levelControl');
        assert.equal(updates.length, before + 1);
        assert.equal(updates.slice(-1)[0].state.currentLevel, 127);
    });

    it('awaits registration before subscribing and flushes the latest state, including offline reachability', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const pending = gate();
        f.hooks.register = () => pending.promise;
        const light = f.entry('light', {}, { on: false });
        const sync = f.bridge.sync([light]);
        await settle();
        assert.equal(f.registered.length, 1);
        assert.equal(light.device.listeners.size, 0);
        assert.equal(f.updates.length, 0);
        light.device.change({ online: false, on: true });
        pending.resolve();
        await sync;
        await settle();
        assert.equal(light.device.listeners.size, 1);
        assert.equal(f.updates.find(update => update.cluster === 'bridgedDeviceBasicInformation')?.state.reachable, false);
        assert.equal(f.updates.find(update => update.cluster === 'onOff')?.state.onOff, true);
        await assert.rejects(command(f.registered[0], 'onOff', 'on'), Failure);
        assert.equal(light.device.commands.length, 0);
    });

    it('deduplicates state, persists mutable controller context and unregisters removed accessories', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const blind = f.entry('blind', {}, { position: 20, targetPosition: 20 });
        await f.bridge.sync([blind]);
        await settle();
        const first = f.updates.length;
        await f.bridge.sync([blind]);
        blind.device.change({ position: 20 });
        await settle();
        assert.equal(f.updates.length, first);
        assert.equal(f.registered.length, 1);
        assert.equal(blind.device.listeners.size, 1);
        blind.context.currentPosition = 42;
        blind.device.change({ position: 42, name: 'Kitchen' });
        await settle();
        const context = f.persisted.slice(-1)[0]?.context as { deviceContext: Record<string, unknown> };
        assert.equal(context.deviceContext.currentPosition, 42);
        assert.equal(f.persisted.slice(-1)[0]?.displayName, 'Kitchen');
        await f.bridge.sync([]);
        assert.equal(f.removed.length, 1);
        assert.equal(blind.device.listeners.size, 0);
        const removedAt = f.updates.length;
        blind.device.change({ position: 50 });
        await settle();
        assert.equal(f.updates.length, removedAt);
    });

    it('restores matching cached descriptors and replaces changed cached endpoint shapes', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light', { dimmer: false }, { on: true });
        await f.bridge.sync([light]);
        await settle();
        const cached = f.registered[0];
        f.bridge.destroy();
        const restored = fixture(); t.after(() => restored.bridge.destroy());
        restored.bridge.configureAccessory(cached);
        await restored.bridge.sync([light]);
        assert.equal(restored.registered.length, 1);
        assert.equal(restored.removed.length, 0);
        assert.equal(light.device.listeners.size, 1);
        restored.bridge.destroy();
        const changed = fixture(); t.after(() => changed.bridge.destroy());
        changed.bridge.configureAccessory(cached);
        const dimmer = changed.entry('light', { dimmer: true }, { on: true });
        await changed.bridge.sync([dimmer]);
        assert.deepEqual(changed.removed, [cached]);
        assert.equal((changed.registered[0].deviceType as unknown as DeviceType).name, 'DimmableLight');
    });

    it('replaces live controllers and recovers reconciliation after an unregister failure', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const first = f.entry('light');
        await f.bridge.sync([first]);
        const replacement = f.entry('light', { dimmer: true });
        f.hooks.unregister = () => Promise.reject(new Error('temporary failure'));
        await assert.rejects(f.bridge.sync([replacement]), /temporary failure/);
        assert.equal(first.device.listeners.size, 0);
        f.hooks.unregister = undefined;
        await f.bridge.sync([replacement]);
        assert.equal(f.registered.length, 2);
        assert.equal(replacement.device.listeners.size, 1);
    });

    it('rebuilds restored dimmers to reattach custom public LevelControl behavior', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light', { dimmer: true }, { on: true });
        await f.bridge.sync([light]);
        await settle();
        const cached = f.registered[0];
        assert.equal(cached.handlers?.levelControl, undefined);
        f.bridge.destroy();
        const restored = fixture(); t.after(() => restored.bridge.destroy());
        restored.bridge.configureAccessory(cached);
        await restored.bridge.sync([light]);
        assert.deepEqual(restored.removed, [cached]);
        assert.equal(restored.registered.length, 1);
        await command(restored.registered[0], 'levelControl', 'stepWithOnOff', { stepMode: 1, stepSize: 20 });
        assert.equal(light.device.commands.length, 1);
    });

    it('can retry failed registration and cleans stale restored devices', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light');
        f.hooks.register = () => Promise.reject(new Error('temporary registration failure'));
        await f.bridge.sync([light]);
        assert.equal(light.device.listeners.size, 0);
        f.hooks.register = undefined;
        await f.bridge.sync([light]);
        assert.equal(light.device.listeners.size, 1);
        const stale = { ...f.registered[1], UUID: 'stale' };
        f.bridge.configureAccessory(stale);
        await f.bridge.sync([light]);
        assert.deepEqual(f.removed, [stale]);
    });

    it('does not subscribe or publish late state if shutdown happens during registration', async () => {
        const f = fixture();
        const pending = gate();
        f.hooks.register = () => pending.promise;
        const light = f.entry('light');
        const sync = f.bridge.sync([light]);
        await settle();
        f.bridge.destroy();
        pending.resolve();
        await sync;
        await settle();
        assert.equal(light.device.listeners.size, 0);
        assert.equal(f.updates.length, 0);
        await assert.rejects(command(f.registered[0], 'onOff', 'on'), InvalidInState);
    });

    it('serializes asynchronous state writes and retains changes arriving during a write', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light', {}, { on: false });
        const pending = gate();
        f.hooks.update = () => pending.promise;
        await f.bridge.sync([light]);
        await settle();
        light.device.change({ on: true });
        await settle();
        assert.equal(f.updates.length, 0);
        pending.resolve();
        await settle();
        assert.equal(f.updates.filter(update => update.cluster === 'onOff').slice(-1)[0]?.state.onOff, true);
    });

    it('awaits asynchronous commands and translates shared-controller errors into Matter errors', async t => {
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light');
        await f.bridge.sync([light]);
        const accessory = f.registered[0];
        const pending = gate();
        light.device.behavior = async () => { await pending.promise; light.device.change({ on: true }); };
        let complete = false;
        const operation = command(accessory, 'onOff', 'on').then(() => { complete = true; });
        await settle();
        assert.equal(complete, false);
        pending.resolve();
        await operation;
        assert.equal(light.device.snapshot().on, true);
        for (const [code, type] of [[-70403, Busy], [-70412, InvalidInState], [-70408, Timeout], [-70402, Failure]] as const) {
            light.device.behavior = () => Promise.reject(Object.assign(new Error('command failed'), { hapStatus: code }));
            await assert.rejects(command(accessory, 'onOff', 'off'), type);
        }
        const original = new ConstraintError('hardware constraint');
        light.device.behavior = () => { throw original; };
        await assert.rejects(command(accessory, 'onOff', 'off'), error => error === original);
    });

    it('stops continuous dimming on stop commands, power commands and destruction', async t => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light', { dimmer: true }, { on: true, brightness: 50 });
        await f.bridge.sync([light]);
        const accessory = f.registered[0];
        await command(accessory, 'levelControl', 'move', { moveMode: 0, rate: 100 });
        t.mock.timers.tick(250);
        await settle();
        assert.deepEqual(light.device.commands, [{ type: 'brightness', value: 60 }]);
        await command(accessory, 'levelControl', 'stop');
        t.mock.timers.tick(1000);
        assert.equal(light.device.commands.length, 1);
        await command(accessory, 'levelControl', 'move', { moveMode: 1, rate: 100 });
        await command(accessory, 'onOff', 'off');
        t.mock.timers.tick(1000);
        assert.equal(light.device.commands.length, 2);
        light.device.change({ on: true });
        await command(accessory, 'levelControl', 'move', { moveMode: 0, rate: 100 });
        f.bridge.destroy();
        t.mock.timers.tick(1000);
        assert.equal(light.device.commands.length, 2);
    });

    it('supports the WithOnOff step, move and stop hooks, including turning on an off light', async t => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const f = fixture(); t.after(() => f.bridge.destroy());
        const light = f.entry('light', { dimmer: true }, { on: false, brightness: 50 });
        await f.bridge.sync([light]);
        const accessory = f.registered[0];
        await command(accessory, 'levelControl', 'stepWithOnOff', { stepMode: 0, stepSize: 25 });
        assert.deepEqual(light.device.commands, [{ type: 'brightness', value: 60 }]);
        light.device.change({ on: false });
        await command(accessory, 'levelControl', 'moveWithOnOff', { moveMode: 0, rate: 100 });
        t.mock.timers.tick(250);
        await settle();
        assert.equal(light.device.commands.length, 2);
        assert.equal(light.device.snapshot().on, true);
        await command(accessory, 'levelControl', 'stopWithOnOff');
        t.mock.timers.tick(1000);
        assert.equal(light.device.commands.length, 2);
        light.device.change({ on: false });
        await command(accessory, 'levelControl', 'moveWithOnOff', { moveMode: 0, rate: 100 });
        await command(accessory, 'levelControl', 'stopWithOnOff');
        t.mock.timers.tick(1000);
        assert.equal(light.device.commands.length, 2, 'stop cancels even before the first hardware tick');
        await command(accessory, 'levelControl', 'moveWithOnOff', { moveMode: 0, rate: null });
        assert.deepEqual(light.device.commands.slice(-1)[0], { type: 'brightness', value: 100 });
    });
});
