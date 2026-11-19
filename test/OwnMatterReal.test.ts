import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import type { API, Logging, MatterAccessory, PlatformAccessory } from 'homebridge';
import type { InternalMatterAccessory } from 'homebridge/dist/matter/types';
import { OwnMatterBridge, type MatterDeviceEntry } from '../lib/OwnMatterBridge';
import type { DeviceCommand, DeviceEvent, DeviceKind, DeviceState, OwnDevice } from '../lib/OwnDevice';
import { OwnBlindAccessory, type OwnPlatformLike } from '../lib/OwnAccessory';
import { makeMockAccessory, makeMockPlatform } from './helpers';

// Preserve native import(): TypeScript otherwise rewrites it to require(), but
// Homebridge's Matter API is ESM and uses top-level await. No bridge is started
// or published: the real endpoints live in a ServerNode with in-memory storage.
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- Fixed loader body preserves native ESM import in CommonJS output.
const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
const homebridgeDist = dirname(require.resolve('homebridge'));
async function runtime() {
    const load = (path: string) => nativeImport(pathToFileURL(path).href);
    const [main, endpoints, manager, state, registry, registryManager, types, errors, switches, api] = await Promise.all([
        load(require.resolve('@matter/main').replace('/cjs/', '/esm/')),
        load(require.resolve('@matter/main/endpoints').replace('/cjs/', '/esm/')),
        load(join(homebridgeDist, 'matter/server/AccessoryManager.js')),
        load(join(homebridgeDist, 'matter/server/StateManager.js')),
        load(join(homebridgeDist, 'matter/behaviors/BehaviorRegistry.js')),
        load(join(homebridgeDist, 'matter/behaviors/RegistryManager.js')),
        load(join(homebridgeDist, 'matter/types.js')),
        load(join(homebridgeDist, 'matter/errors.js')),
        load(join(homebridgeDist, 'matter/SwitchAPI.js')),
        load(join(homebridgeDist, 'api.js')),
    ]);
    return {
        ...main as typeof import('@matter/main'),
        ...endpoints as { AggregatorEndpoint: unknown },
        ...manager as typeof import('homebridge/dist/matter/server/AccessoryManager'),
        ...state as typeof import('homebridge/dist/matter/server/StateManager'),
        ...registry as typeof import('homebridge/dist/matter/behaviors/BehaviorRegistry'),
        ...registryManager as typeof import('homebridge/dist/matter/behaviors/RegistryManager'),
        ...types as typeof import('homebridge/dist/matter/types'),
        ...errors as typeof import('homebridge/dist/matter/errors'),
        ...switches as typeof import('homebridge/dist/matter/SwitchAPI'),
        ...api as typeof import('homebridge/dist/api'),
    };
}

class Device implements OwnDevice {
    commands: DeviceCommand[] = [];
    private listeners = new Set<(event: DeviceEvent) => void>();
    constructor(private state: DeviceState) {}
    snapshot(): DeviceState { return { ...this.state }; }
    execute(command: DeviceCommand): void {
        this.commands.push(command);
        switch (command.type) {
            case 'power': this.change({ on: command.value }); break;
            case 'brightness': this.change({ brightness: command.value, on: command.value > 0 }); break;
            case 'position': this.change({ targetPosition: command.value }); break;
            case 'temperature': this.change({ targetTemperature: command.value }); break;
            case 'mode': this.change({ mode: command.value }); break;
            case 'unlock': this.change({ locked: false }); break;
            case 'activate': this.change({ on: true }); break;
            case 'stop': this.change({ moving: 'stopped', targetPosition: this.state.position }); break;
        }
    }
    change(state: Partial<DeviceState>): void { this.state = { ...this.state, ...state }; this.emit({ type: 'state', state: this.snapshot() }); }
    emit(event: DeviceEvent): void { for (const listener of this.listeners) listener(event); }
    subscribe(listener: (event: DeviceEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

async function fixture(t: TestContext) {
    const r = await runtime();
    const environment = new r.Environment(`myhome-test-${t.name}`, r.Environment.default);
    new r.MockStorageService(environment);
    // The project targets CommonJS resolution; Matter's re-exported endpoint
    // generics require NodeNext. Keep this ESM test boundary structural.
    const ServerNode = r.ServerNode as unknown as { create(options: unknown): Promise<{ add(endpoint: unknown): Promise<unknown>; close(): Promise<void> }> };
    const Endpoint = r.Endpoint as unknown as { new(type: unknown, options: unknown): unknown };
    const node = await ServerNode.create({
        id: 'myhome-test', environment,
        basicInformation: { vendorId: 0xfff1, productId: 1, vendorName: 'Test', productName: 'MyHome test', nodeLabel: 'MyHome test', serialNumber: 'test' },
    });
    const aggregator = await node.add(new Endpoint(r.AggregatorEndpoint, { id: 'aggregator' }));
    const accessories = new Map<string, InternalMatterAccessory>();
    const manager = new r.AccessoryManager();
    const stateManager = new r.StateManager(accessories, new EventEmitter(), () => false);
    const deps = {
        config: { externalAccessory: false, debugModeEnabled: false } as import('homebridge/dist/matter/sharedTypes').MatterServerConfig,
        accessories, behaviorRegistry: new r.BehaviorRegistry(accessories), registryManager: new r.RegistryManager(), accessoryCache: null,
        getServerNode: () => node, getAggregator: () => aggregator, getIsRunning: () => false, getMonitoringEnabled: () => false, isCommissioned: () => false,
    } as unknown as import('homebridge/dist/matter/server/AccessoryManager').AccessoryManagerDeps;
    const failures: string[] = [];
    const log = { error: (...args: unknown[]) => failures.push(format(...args)), warn: (...args: unknown[]) => failures.push(format(...args)) } as unknown as Logging;
    const updates: Promise<void>[] = [];
    const matter = {
        deviceTypes: r.deviceTypes, deviceRequirements: r.deviceRequirements, status: r.MatterStatus,
        registerPlatformAccessories: async (plugin: string, platform: string, items: MatterAccessory[]) => {
            for (const item of items) await manager.registerAccessory(plugin, platform, item, deps);
        },
        unregisterPlatformAccessories: async (_plugin: string, _platform: string, items: MatterAccessory[]) => {
            for (const item of items) await manager.unregisterAccessory(item.UUID, deps);
        },
        updatePlatformAccessories: async (_items: MatterAccessory[]) => {},
        updateAccessoryState: (UUID: string, cluster: string, attributes: Record<string, unknown>, partId?: string) => {
            const promise = stateManager.updateAccessoryState(UUID, cluster, attributes, partId);
            updates.push(promise);
            return promise;
        },
    };
    const homebridge = new r.HomebridgeAPI();
    const api = {
        versionGreaterOrEqual: homebridge.versionGreaterOrEqual.bind(homebridge),
        matter: { ...matter, switch: new r.SwitchAPIImpl(matter as unknown as NonNullable<API['matter']>) },
    } as unknown as API;
    let bridge = new OwnMatterBridge(api, log);
    t.after(async () => { bridge.destroy(); await node.close(); });
    let nextId = 0;
    const entry = (kind: DeviceKind, config: Record<string, unknown> = {}, state: Partial<DeviceState> = {}): MatterDeviceEntry & { device: Device } => ({
        UUID: `00000000-0000-0000-0000-${String(++nextId).padStart(12, '0')}`, kind, config, context: { type: kind, device: config },
        device: new Device({ name: kind, online: true, ...state }),
    });
    const state = (entry: MatterDeviceEntry, cluster: string, partId?: string): Record<string, unknown> => {
        const result = stateManager.getAccessoryState(entry.UUID, cluster, partId);
        assert.ok(result, `Missing ${entry.kind}/${partId ?? 'parent'}/${cluster}`);
        return result;
    };
    const settle = async () => {
        // Flush the adapter's zero-delay batch, then every actual endpoint write,
        // including writes queued by a command's synchronous hardware event.
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        while (updates.length) await Promise.all(updates.splice(0));
        assert.deepEqual(failures, [], 'Matter registration and state updates must succeed');
    };
    return {
        get bridge() { return bridge; }, entry, state, settle, accessories,
        restoresComposedTypes: api.versionGreaterOrEqual('2.5.0'),
        command: (entry: MatterDeviceEntry, cluster: string, command: string, args?: Record<string, unknown>, partId?: string) =>
            stateManager.triggerCommand(entry.UUID, cluster, command, cluster === 'levelControl' ? { optionsMask: {}, optionsOverride: {}, ...args } : args, partId),
        write: (entry: MatterDeviceEntry, cluster: string, attributes: Record<string, unknown>) => stateManager.updateAccessoryState(entry.UUID, cluster, attributes),
        restore: async (entries: MatterDeviceEntry[]) => {
            bridge.destroy();
            bridge = new OwnMatterBridge(api, log);
            for (const accessory of accessories.values()) { accessory._restoredFromCache = true; bridge.configureAccessory(accessory); }
            await bridge.sync(entries);
        },
    };
}

describe('OwnMatterBridge with real Homebridge Matter endpoints', { timeout: 30000 }, () => {
    it('publishes unknown blind positions and shares the calibration/STOP controls with HAP', async t => {
        const f = await fixture(t);
        const platform = makeMockPlatform();
        const accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        const config = { id: 2, time: 20, calibration: 'manual' as const };
        const device = new OwnBlindAccessory(platform as unknown as OwnPlatformLike, accessory as unknown as PlatformAccessory, config);
        t.after(() => device.destroy());
        device.setOnline(true);
        device.onData('*#2*2*10*10*255*0*0##');
        const entry = { ...f.entry('blind', config), device, context: accessory.context };
        await f.bridge.sync([entry]); await f.settle();
        assert.equal(f.state(entry, 'windowCovering').currentPositionLiftPercent100ths, null);
        await assert.rejects(f.command(entry, 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 5000 }));
        await f.command(entry, 'onOff', 'on', undefined, 'calibration'); await f.settle();
        assert.equal(f.state(entry, 'onOff', 'calibration').onOff, true);
        assert.equal(accessory.services.Switch.characteristics.On.getter!(), true);
        await accessory.services.WindowCovering.characteristics.HoldPosition.setter!(true);
        await f.settle();
        assert.equal(f.state(entry, 'onOff', 'calibration').onOff, false);
        assert.equal(f.state(entry, 'windowCovering').currentPositionLiftPercent100ths, null);
        assert.equal(device.snapshot().moving, 'stopped');
        assert.deepEqual(platform.sendCommandSpy.calls.map(([params]) => (params as { command: string }).command), ['*2*2*2##', '*2*0*2##']);
    });

    it('registers all mappings and publishes hardware updates through validated clusters and parts', async t => {
        const f = await fixture(t);
        const light = f.entry('light', {}, { on: false, online: false, name: 'Éclairage du très grand séjour ☀️'.repeat(3) });
        const dimmer = f.entry('light', { dimmer: true }, { on: true, brightness: 50 });
        const blind = f.entry('blind', {}, { position: 40, targetPosition: 70 });
        const thermostats = ['heat', 'cool', 'both'].map(matterMode => f.entry('thermostat', { matterMode }, { mode: 'auto', activeMode: matterMode === 'cool' ? 'cool' : 'heat', temperature: 21, targetTemperature: 20 }));
        const sensors = ['contact', 'motion', 'occupancy', 'leak', 'smoke', 'co'].map(sensorType => f.entry('contact', { sensorType }, { triggered: false }));
        const energy = f.entry('energy', {}, { watts: 250 });
        const door = f.entry('door', { doorbell: true }, { locked: true });
        const scenario = f.entry('scenario', {}, { on: false });
        const entries = [light, dimmer, blind, ...thermostats, ...sensors, energy, door, scenario];
        await f.bridge.sync(entries);
        await f.settle();
        assert.equal(f.accessories.size, 15);
        const info = f.state(light, 'bridgedDeviceBasicInformation');
        assert.equal(info.reachable, false);
        assert.equal(Buffer.byteLength(String(info.nodeLabel)) <= 32, true);
        assert.equal(String(info.serialNumber).length, 32);
        assert.equal(f.state(dimmer, 'levelControl').currentLevel, 127);
        assert.equal(f.state(blind, 'windowCovering').currentPositionLiftPercent100ths, 6000);
        assert.equal(f.state(blind, 'windowCovering').targetPositionLiftPercent100ths, 3000);
        assert.equal(f.state(energy, 'electricalPowerMeasurement').activePower, 250000);
        for (const thermostat of thermostats) {
            const state = f.state(thermostat, 'thermostat');
            assert.equal(state.localTemperature, 2100);
            assert.equal(state.thermostatRunningMode, undefined);
            assert.equal((state.featureMap as { autoMode: boolean }).autoMode, false);
            assert.equal(f.state(thermostat, 'onOff', 'programme').onOff, true);
            assert.deepEqual(thermostat.device.commands, [], 'initial attribute updates must not send commands back to the thermostat');
        }
        for (const sensor of sensors) sensor.device.change({ triggered: true });
        energy.device.change({ watts: 237.5 });
        light.device.change({ online: true, on: true });
        blind.device.change({ position: 75, targetPosition: 100, moving: 'opening' });
        await f.settle();
        assert.equal(f.state(light, 'bridgedDeviceBasicInformation').reachable, true);
        assert.equal(f.state(light, 'onOff').onOff, true);
        assert.equal(f.state(blind, 'windowCovering').currentPositionLiftPercent100ths, 2500);
        assert.equal(f.state(energy, 'electricalPowerMeasurement').activePower, 237500);
        assert.equal(f.state(sensors[0], 'booleanState').stateValue, false);
        for (const sensor of sensors.slice(1, 3)) assert.equal((f.state(sensor, 'occupancySensing').occupancy as { occupied: boolean }).occupied, true);
        assert.equal(f.state(sensors[3], 'booleanState').stateValue, true);
        assert.equal(f.state(sensors[4], 'smokeCoAlarm').smokeState, 2);
        assert.equal(f.state(sensors[5], 'smokeCoAlarm').coState, 2);
        assert.equal(f.state(door, 'doorLock').operatingMode, 0);
        assert.equal((f.state(door, 'doorLock').supportedOperatingModes as { normal: boolean }).normal, true);
        const button = f.accessories.get(door.UUID)!._parts!.find(part => part.id === 'doorbell')!.endpoint!;
        let presses = 0;
        const buttonEvents = button.events as unknown as { switch: { initialPress: { on(listener: () => void): void } } };
        buttonEvents.switch.initialPress.on(() => { presses++; });
        door.device.emit({ type: 'doorbell' });
        door.device.emit({ type: 'doorbell' });
        await f.settle();
        assert.equal(presses, 2);
        assert.equal(f.state(door, 'switch', 'doorbell').currentPosition, 0);
        await f.command(door, 'doorLock', 'unlockDoor');
        await f.command(scenario, 'onOff', 'on');
        await f.command(blind, 'windowCovering', 'goToLiftPercentage', { liftPercent100thsValue: 3200 });
        await f.settle();
        assert.deepEqual(door.device.commands, [{ type: 'unlock' }]);
        assert.deepEqual(scenario.device.commands, [{ type: 'activate' }]);
        assert.deepEqual(blind.device.commands, [{ type: 'position', value: 68 }]);
        assert.equal(f.state(door, 'doorLock').lockState, 2);
        scenario.device.change({ on: false });
        await f.settle();
        assert.equal(f.state(scenario, 'onOff').onOff, false);
    });

    it('handles thermostat programme changes and manual setpoints without command echoes', async t => {
        const f = await fixture(t);
        const thermostat = f.entry('thermostat', { matterMode: 'both' }, { mode: 'auto', activeMode: 'heat', targetTemperature: 20, temperature: 21 });
        await f.bridge.sync([thermostat]);
        await f.settle();
        thermostat.device.change({ targetTemperature: 22, temperature: 21.25 });
        await f.settle();
        assert.equal(f.state(thermostat, 'thermostat').occupiedHeatingSetpoint, 2200);
        assert.deepEqual(thermostat.device.commands, []);
        // Local offline writes dispatch Homebridge reactors asynchronously; they
        // do not carry the response path of a remote Matter write transaction.
        await f.write(thermostat, 'thermostat', { occupiedHeatingSetpoint: 2300 });
        await f.settle();
        assert.deepEqual(thermostat.device.commands, [], 'scheduled mode must reject the hardware command');
        assert.equal(thermostat.device.snapshot().mode, 'auto');
        assert.equal(f.state(thermostat, 'thermostat').occupiedHeatingSetpoint, 2200);
        await f.command(thermostat, 'onOff', 'off', undefined, 'programme');
        await f.settle();
        await f.write(thermostat, 'thermostat', { occupiedHeatingSetpoint: 2300 });
        await f.settle();
        await f.command(thermostat, 'thermostat', 'setpointRaiseLower', { mode: 0, amount: 10 });
        await f.settle();
        await f.command(thermostat, 'onOff', 'on', undefined, 'programme');
        await f.settle();
        assert.deepEqual(thermostat.device.commands, [
            { type: 'mode', value: 'heat' }, { type: 'temperature', value: 23 },
            { type: 'temperature', value: 24 }, { type: 'mode', value: 'auto' },
        ]);
        assert.equal(f.state(thermostat, 'thermostat').occupiedHeatingSetpoint, 2400);
        assert.equal(f.state(thermostat, 'onOff', 'programme').onOff, true);
    });

    it('preserves composed endpoint identity on Homebridge 2.5 and restores its feature choices and handlers', async t => {
        const f = await fixture(t);
        const thermostat = f.entry('thermostat', { matterMode: 'cool' }, { mode: 'cool', temperature: 24, targetTemperature: 22 });
        const sensor = f.entry('contact', { sensorType: 'occupancy' }, { triggered: false });
        const entries = [thermostat, sensor];
        await f.bridge.sync(entries); await f.settle();
        const endpoints = entries.map(entry => f.accessories.get(entry.UUID)!.endpoint);
        const identities = entries.map(entry => f.state(entry, 'bridgedDeviceBasicInformation').uniqueId);
        const features = [f.state(thermostat, 'thermostat').featureMap, f.state(sensor, 'occupancySensing').featureMap];
        await f.restore(entries); await f.settle();
        for (const [index, entry] of entries.entries()) {
            if (f.restoresComposedTypes) {
                assert.ok(f.accessories.get(entry.UUID)!.endpoint === endpoints[index], `${entry.kind} endpoint must survive restoration`);
                assert.equal(f.state(entry, 'bridgedDeviceBasicInformation').uniqueId, identities[index]);
            } else {
                assert.ok(f.accessories.get(entry.UUID)!.endpoint !== endpoints[index], 'Homebridge 2.4 requires reconstruction');
            }
        }
        assert.deepEqual(f.state(thermostat, 'thermostat').featureMap, features[0]);
        assert.deepEqual(f.state(sensor, 'occupancySensing').featureMap, features[1]);
        await f.command(thermostat, 'onOff', 'on', undefined, 'programme'); await f.settle();
        await f.command(thermostat, 'onOff', 'off', undefined, 'programme'); await f.settle();
        await f.write(thermostat, 'thermostat', { occupiedCoolingSetpoint: 2300 });
        sensor.device.change({ triggered: true }); await f.settle();
        assert.deepEqual(thermostat.device.commands, [{ type: 'mode', value: 'auto' }, { type: 'mode', value: 'cool' }, { type: 'temperature', value: 23 }]);
        assert.equal((f.state(sensor, 'occupancySensing').occupancy as { occupied: boolean }).occupied, true);
    });

    it('runs all eight dimmer commands and retains endpoint numbers when cached behaviors are replaced', async t => {
        const f = await fixture(t);
        const dimmer = f.entry('light', { dimmer: true }, { on: true, brightness: 50 });
        const thermostat = f.entry('thermostat', {}, { mode: 'heat', targetTemperature: 20 });
        await f.bridge.sync([dimmer, thermostat]);
        await f.settle();
        const number = f.accessories.get(dimmer.UUID)!.endpoint!.number;
        const dimmerEndpoint = f.accessories.get(dimmer.UUID)!.endpoint;
        const thermostatNumber = f.accessories.get(thermostat.UUID)!.endpoint!.number;
        const programmeNumber = f.accessories.get(thermostat.UUID)!._parts![0].endpoint!.number;
        await f.restore([dimmer, thermostat]);
        await f.settle();
        assert.equal(f.accessories.get(dimmer.UUID)!.endpoint!.number, number);
        assert.ok(f.accessories.get(dimmer.UUID)!.endpoint !== dimmerEndpoint, 'custom LevelControl must be reconstructed on every supported Homebridge version');
        assert.equal(f.accessories.get(thermostat.UUID)!.endpoint!.number, thermostatNumber);
        assert.equal(f.accessories.get(thermostat.UUID)!._parts![0].endpoint!.number, programmeNumber);
        const command = async (name: string, args?: Record<string, unknown>) => { await f.command(dimmer, 'levelControl', name, args); await f.settle(); };
        await command('moveToLevel', { level: 254, transitionTime: 0 });
        await command('step', { stepMode: 1, stepSize: 127, transitionTime: 0 });
        await command('moveToLevelWithOnOff', { level: 0, transitionTime: 0 });
        assert.equal(dimmer.device.snapshot().on, false);
        const offCommandCount = dimmer.device.commands.length;
        await command('moveToLevel', { level: 200, transitionTime: 0 });
        assert.equal(dimmer.device.commands.length, offCommandCount);
        await command('stepWithOnOff', { stepMode: 0, stepSize: 127, transitionTime: 0 });
        assert.equal(dimmer.device.snapshot().on, true);
        await command('move', { moveMode: 0, rate: 100 });
        await new Promise<void>(resolve => setTimeout(resolve, 280));
        await command('stop');
        assert.ok(dimmer.device.snapshot().brightness! > 50);
        dimmer.device.change({ on: false, brightness: 50 });
        await f.settle();
        await command('moveWithOnOff', { moveMode: 0, rate: 100 });
        await command('stopWithOnOff');
        const stoppedCommandCount = dimmer.device.commands.length;
        await new Promise<void>(resolve => setTimeout(resolve, 280));
        assert.equal(dimmer.device.commands.length, stoppedCommandCount, 'stop must cancel a move before its first tick while off');
        await command('moveWithOnOff', { moveMode: 0, rate: null });
        assert.deepEqual(dimmer.device.commands.slice(-1)[0], { type: 'brightness', value: 100 });
        dimmer.device.change({ online: false });
        await f.settle();
        await assert.rejects(command('stepWithOnOff', { stepMode: 1, stepSize: 20, transitionTime: 0 }), /offline/);
    });
});
