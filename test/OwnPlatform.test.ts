import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { makeMockPlatform, makeSpy } from './helpers';
import { OwnPlatform } from '../lib/OwnPlatform';
import { OwnLightAccessory } from '../lib/OwnAccessory';
import type { OwnClient } from '../lib/OwnNet';
import { OwnConnection, PKT, STATE } from '../lib/OwnNet';
import { PLUGIN_NAME, PLUGIN_VERSION } from '../lib/constants';
import type { API, Logging, MatterAccessory, PlatformAccessory } from 'homebridge';
import type { MatterDeviceEntry } from '../lib/OwnMatterBridge';

function makeCharStub() {
    const stub: Record<string, unknown> = {
        value: undefined,
        onGet: () => stub,
        onSet: () => stub,
        setProps: () => stub,
        updateValue: (v: unknown) => { stub.value = v; return stub; },
        setCharacteristic: () => stub,
    };
    return stub;
}

function makeAccessoryStub(name: string, uuid: string): PlatformAccessory {
    const services: Record<string, unknown> = {};
    function addSvc(svc: string): unknown {
        const chars: Record<string, ReturnType<typeof makeCharStub>> = {};
        services[svc] = {
            setPrimaryService: () => services[svc],
            addLinkedService: () => services[svc],
            getCharacteristic: (c: string) => {
                if (!chars[c]) chars[c] = makeCharStub();
                return chars[c];
            },
            setCharacteristic: () => services[svc],
            updateCharacteristic: () => services[svc],
        };
        return services[svc];
    }
    addSvc('AccessoryInformation');
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    return {
        displayName: name,
        UUID: uuid,
        context: {},
        getService: (svc: string) => services[svc] ?? null,
        addService: (svc: string) => addSvc(svc),
        removeService: (svc: { name?: string } | string) => {
            const key = typeof svc === 'string' ? svc : svc.name ?? '';
            delete services[key];
        },
        on: (event: string, cb: (...args: unknown[]) => void) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
        },
        removeAllListeners: (event?: string) => {
            if (event) delete listeners[event]; else Object.keys(listeners).forEach(k => delete listeners[k]);
        },
    } as unknown as PlatformAccessory;
}

interface MockApi {
    hap: {
        uuid: { generate: (s: string) => string };
        Service: Record<string, string>;
        Characteristic: ReturnType<typeof makeMockPlatform>['Characteristic'];
    };
    on: (event: string, cb: () => void) => void;
    platformAccessory: new (name: string, uuid: string) => PlatformAccessory;
    registerPlatformAccessories: (...args: unknown[]) => void;
    updatePlatformAccessories: (...args: unknown[]) => void;
    unregisterPlatformAccessories: (...args: unknown[]) => void;
    registered: unknown[][];
    updated: unknown[][];
    unregistered: unknown[][];
}

function makeMockApi(): MockApi {
    const registered: unknown[][] = [];
    const updated: unknown[][] = [];
    const unregistered: unknown[][] = [];

    return {
        hap: {
            uuid: { generate: (s: string) => `uuid-${s}` },
            Service: {
                AccessoryInformation: 'AccessoryInformation',
                Lightbulb: 'Lightbulb',
                WindowCovering: 'WindowCovering',
                Thermostat: 'Thermostat',
                Switch: 'Switch',
                ContactSensor: 'ContactSensor',
                MotionSensor: 'MotionSensor',
                OccupancySensor: 'OccupancySensor',
                LeakSensor: 'LeakSensor',
                SmokeSensor: 'SmokeSensor',
                CarbonMonoxideSensor: 'CarbonMonoxideSensor',
                LightSensor: 'LightSensor',
                TemperatureSensor: 'TemperatureSensor',
                StatelessProgrammableSwitch: 'StatelessProgrammableSwitch',
                Outlet: 'Outlet',
                LockMechanism: 'LockMechanism',
                Doorbell: 'Doorbell',
            },
            Characteristic: makeMockPlatform().Characteristic,
        },
        on: (event: string, cb: () => void) => { if (event === 'didFinishLaunching') cb(); },
        platformAccessory: makeAccessoryStub as unknown as new (name: string, uuid: string) => PlatformAccessory,
        registerPlatformAccessories: (...args: unknown[]) => { registered.push(args); },
        updatePlatformAccessories: (...args: unknown[]) => { updated.push(args); },
        unregisterPlatformAccessories: (...args: unknown[]) => { unregistered.push(args); },
        registered: registered,
        updated: updated,
        unregistered: unregistered,
    };
}

function makePlatformInstance(config: Record<string, unknown>, api: MockApi): OwnPlatform {
    const defaultConfig = { expose: 'homekit', port: 20000, lights: [], blinds: [], thermostats: [], scenarios: [], contacts: [], energies: [] };
    const mergedConfig = { ...defaultConfig, ...config };

    const log: Logging = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, success: () => {} } as unknown as Logging;

    const platform = {
        config: mergedConfig,
        log: log,
        api: api as unknown as API,
        Service: api.hap.Service,
        Characteristic: api.hap.Characteristic,
        HapStatusError: function (this: { code: number }, code: number) { this.code = code; } as unknown as new (status: number) => Error,
        cachedAccessories: [] as PlatformAccessory[],
        activeHandlers: [],
        virtualAccessories: new Set<string>(),
        staggerTimers: [],
        stopped: false,
        pendingPersistence: new Set(),
        controller: Object.assign(new EventEmitter(), { sendCommand: makeSpy(), cancelQueued: () => {}, startMonitor: () => {}, commandQueue: [] as unknown[], queueSize: () => 0 }),
    };

    return Object.setPrototypeOf(platform, OwnPlatform.prototype) as unknown as OwnPlatform;
}

describe('OwnPlatform.discoverDevices', () => {
    it('skips malformed device entries before generating or registering accessories', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', lights: [null, {}, { id: 1, name: 'Valid' }], blinds: 'not-an-array' }, api);
        assert.doesNotThrow(() => platform.discoverDevices());
        assert.equal(platform.activeHandlers.length, 1);
        assert.equal(api.registered.length, 1);
        platform.activeHandlers.forEach(handler => handler.destroy());
    });
    it('routes standard WHO25 dry-contact events to the configured sensor', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', contacts: [{ id: 1, protocol: 'dry-contact' }] }, api);
        platform.discoverDevices();
        try {
            platform.onMonitor('*25*31#1*31##');
            assert.equal(platform.activeHandlers[0].snapshot().triggered, false);
            platform.onMonitor('*25*32#0*31##');
            assert.equal(platform.activeHandlers[0].snapshot().triggered, true);
        } finally { platform.activeHandlers.forEach(handler => handler.destroy()); }
    });
    it('batches intermediate position persistence and flushes a STOP immediately', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1' }, api);
        const first = makeAccessoryStub('Blind 1', 'blind-1');
        const second = makeAccessoryStub('Blind 2', 'blind-2');
        platform.persistAccessory(first, false);
        platform.persistAccessory(second, false);
        assert.equal(api.updated.length, 0);
        t.mock.timers.tick(1000);
        assert.deepEqual(api.updated, [[[first, second]]]);
        platform.persistAccessory(first, false);
        platform.persistAccessory(second, true);
        assert.equal(api.updated.length, 2);
        t.mock.timers.tick(1000);
        assert.equal(api.updated.length, 2);
    });

    it('registers new light accessory', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'Kitchen' }] }, api);
        platform.discoverDevices();
        assert.equal(api.registered.length, 1);
        assert.equal(platform.activeHandlers.length, 1);
    });

    it('updates cached accessory', () => {
        const api = makeMockApi();
        const uuid = api.hap.uuid.generate('myhome-light-42');
        const cachedAcc = makeAccessoryStub('Old', uuid);
        const platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'Kitchen' }] }, api);
        platform.cachedAccessories.push(cachedAcc);
        platform.discoverDevices();
        assert.equal(api.registered.length, 0);
        assert.equal(api.updated.length, 1);
        assert.equal(platform.activeHandlers.length, 1);
    });

    it('removes stale cached accessory', () => {
        const api = makeMockApi();
        const staleAcc = makeAccessoryStub('Stale', 'uuid-stale');
        const platform = makePlatformInstance({ host: '127.0.0.1', lights: [] }, api);
        platform.cachedAccessories.push(staleAcc);
        platform.discoverDevices();
        assert.equal(api.unregistered.length, 1);
    });

    it('creates correct handler types', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            lights: [{ id: 1, name: 'L' }],
            blinds: [{ id: 2, name: 'B', time: 20 }],
            thermostats: [{ id: 3, name: 'T', zone: 1 }],
            scenarios: [{ id: 4, name: 'S' }],
            contacts: [{ id: 5, name: 'C' }],
            energies: [{ id: 6, name: 'E' }],
        }, api);
        platform.discoverDevices();
        assert.equal(platform.activeHandlers.length, 6);
        assert.equal(api.registered.length, 6);
        for (const h of platform.activeHandlers) h.destroy();
    });

    it('assigns category 8 (SWITCH) for scenario', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            scenarios: [{ id: 1, name: 'sw' }],
        }, api);
        platform.discoverDevices();
        const registered = api.registered[0]?.[2] as Array<{ category: number }> | undefined;
        assert.ok(registered, 'expected an accessory to be registered');
        assert.equal(registered[0].category, 8, 'scenario should have category SWITCH (8)');
        for (const h of platform.activeHandlers) h.destroy();
    });

    it('assigns category 7 (OUTLET) for asOutlet energy', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            energies: [{ id: 1, asOutlet: true }],
        }, api);
        platform.discoverDevices();
        const registered = api.registered[0]?.[2] as Array<{ category: number }> | undefined;
        assert.ok(registered, 'expected an accessory to be registered');
        assert.equal(registered[0].category, 7, 'asOutlet energy should have category OUTLET (7)');
        for (const h of platform.activeHandlers) h.destroy();
    });

    it('assigns category 6 (DOOR_LOCK) for door accessory', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            doors: [{ id: 1, name: 'gate' }],
        }, api);
        platform.discoverDevices();
        const registered = api.registered[0]?.[2] as Array<{ category: number }> | undefined;
        assert.ok(registered);
        assert.equal(registered[0].category, 6, 'door accessory should have category DOOR_LOCK (6)');
        for (const h of platform.activeHandlers) h.destroy();
    });

    it('refreshes category for cached accessory when asOutlet flag flips', () => {
        const api = makeMockApi();
        const uuid = api.hap.uuid.generate('myhome-energy-1');
        const cached = makeAccessoryStub('E', uuid);
        // simulate previous run with asOutlet:false → category 10 (Sensor)
        (cached as unknown as { category: number }).category = 10;
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            energies: [{ id: 1, name: 'E', asOutlet: true }],
        }, api);
        platform.cachedAccessories.push(cached);
        platform.discoverDevices();
        assert.equal((cached as unknown as { category: number }).category, 7,
            'cached accessory category must be refreshed to OUTLET after asOutlet flip');
        for (const h of platform.activeHandlers) h.destroy();
    });

    it('destroys handler on stale removal', () => {
        const api = makeMockApi();
        const staleAcc = makeAccessoryStub('Stale', 'uuid-stale');
        let destroyed = false;
        const platform = makePlatformInstance({ host: '127.0.0.1', lights: [] }, api);
        platform.cachedAccessories.push(staleAcc);
        platform.activeHandlers.push({ accessory: staleAcc, destroy: () => { destroyed = true; } } as unknown as typeof platform.activeHandlers[number]);
        platform.discoverDevices();
        assert.ok(destroyed);
        assert.equal(platform.activeHandlers.length, 0);
    });

    it('catches handler creation errors without stopping discovery', () => {
        const api = makeMockApi();
        const errors: unknown[][] = [];
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            blinds: [{ id: 1, name: 'bad-blind', time: 0 }],
            lights: [{ id: 2, name: 'good-light' }],
        }, api);
        platform.log.error = function (...args: unknown[]) { errors.push(args); } as typeof platform.log.error;
        platform.discoverDevices();
        assert.ok(errors.some(e => (e[0] as string).includes('Failed to create handler')));
        assert.equal(platform.activeHandlers.length, 1);
        assert.equal(api.registered.length, 1);
    });

    it('warns and skips duplicate accessory IDs', () => {
        const api = makeMockApi();
        const warnings: unknown[][] = [];
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            lights: [{ id: 42, name: 'First' }, { id: 42, name: 'Dupe' }],
        }, api);
        platform.log.warn = function (...args: unknown[]) { warnings.push(args); } as typeof platform.log.warn;
        platform.discoverDevices();
        assert.equal(api.registered.length, 1);
        assert.equal(platform.activeHandlers.length, 1);
        assert.ok(warnings.some(w => (w[0] as string).includes('Duplicate')));
    });
});

describe('OwnPlatform.onMonitor', () => {
    it('routes light packet to onAccessory', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'L' }] }, api);
        platform.discoverDevices();
        let called = false;
        platform.activeHandlers[0].onData = (_p: string) => { called = true; };
        platform.onMonitor('*1*1*42##');
        assert.ok(called);
    });

    it('logs debug for gateway packet', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1' }, api);
        const debugCalls: unknown[][] = [];
        platform.log.debug = function (...args: unknown[]) { debugCalls.push(args); } as typeof platform.log.debug;
        platform.onMonitor('*13*1*0##');
        assert.ok(debugCalls.length > 0);
    });

    it('logs debug for unknown WHO', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1' }, api);
        const debugCalls: unknown[][] = [];
        platform.log.debug = function (...args: unknown[]) { debugCalls.push(args); } as typeof platform.log.debug;
        platform.onMonitor('*99*1*0##');
        assert.ok(debugCalls.length > 0);
    });

    it('catches handler errors without crashing', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'L' }] }, api);
        platform.discoverDevices();
        platform.activeHandlers[0].onData = () => { throw new Error('handler crash'); };
        const errors: unknown[][] = [];
        platform.log.error = function (...args: unknown[]) { errors.push(args); } as typeof platform.log.error;
        platform.onMonitor('*1*1*42##');
        assert.ok(errors.some(e => (e[0] as string).includes('Error processing packet')));
    });

    it('auth-failed event sets all accessories offline and logs error', () => {
        const api = makeMockApi();
        // Capture the didFinishLaunching callback without firing it immediately
        let launchCb: (() => void) | undefined;
        api.on = (event: string, cb: () => void) => { if (event === 'didFinishLaunching') launchCb = cb; };

        const errors: unknown[][] = [];
        const log = {
            info: () => {}, debug: () => {}, warn: () => {},
            error: (...args: unknown[]) => { errors.push(args); },
        } as unknown as import('homebridge').Logging;

        const platform = new OwnPlatform(log, {
            platform: 'MyHome', host: '127.0.0.1', lights: [{ id: 42, name: 'L' }],
        }, api as unknown as API);

        // Replace the real OwnClient with an EventEmitter-based mock before firing launch
        const mockCtrl = Object.assign(new EventEmitter(), {
            detectGatewayModel: (cb: (m: string | null) => void) => cb(null),
            startMonitor: () => {},
            stopMonitor: () => {},
            commandQueue: [] as unknown[],
            queueSize: () => 0,
            maxConcurrent: 2,
        });
        (platform as unknown as { controller: unknown }).controller = mockCtrl;

        assert.ok(launchCb, 'didFinishLaunching callback should be captured');
        launchCb!(); // registers ctrl.on('auth-failed', ...) and calls discoverDevices

        assert.ok(platform.activeHandlers.length > 0);
        let onlineState: boolean | null = null;
        platform.activeHandlers[0].setOnline = (v: boolean) => { onlineState = v; };

        mockCtrl.emit('auth-failed');
        assert.ok(errors.some(e => (e[0] as string).includes('authentication failed')));
        assert.equal(onlineState, false);

        for (const h of platform.activeHandlers) h.destroy();
    });
});

describe('OwnPlatform.onAccessory', () => {
    it('dispatches to matching handler', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'L' }] }, api);
        platform.discoverDevices();
        let received: string | null = null;
        platform.activeHandlers[0].onData = (p: string) => { received = p; };
        platform.onAccessory(1, '42', '*1*1*42##');
        assert.equal(received, '*1*1*42##');
    });

    it('dispatches packet to ALL handlers matching the same WHO and where', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            lights: [{ id: 42, name: 'L' }],
            doors: [{ id: 42, name: 'D' }],
        }, api);
        platform.discoverDevices();
        const lightCalls: string[] = [];
        const doorCalls: string[] = [];
        platform.activeHandlers[0].onData = (p: string) => { lightCalls.push(p); };
        platform.activeHandlers[1].onData = (p: string) => { doorCalls.push(p); };
        // Light packet (WHO=1) → ONLY the light handler should receive it
        platform.onAccessory(1, '42', '*1*1*42##');
        assert.ok(lightCalls.includes('*1*1*42##'), 'light handler must receive light packet');
        assert.equal(doorCalls.length, 0, 'door handler must NOT receive WHO=1 packets');
        // Door packet (WHO=7) → ONLY the door handler should receive it
        platform.onAccessory(7, '42', '*7*8*42##');
        assert.ok(doorCalls.includes('*7*8*42##'), 'door handler must receive WHO=7 packet');
        assert.equal(lightCalls.length, 1, 'light handler must NOT receive WHO=7 packets');
    });

    it('logs debug for unmatched where', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1' }, api);
        const debugCalls: unknown[][] = [];
        platform.log.debug = function (...args: unknown[]) { debugCalls.push(args); } as typeof platform.log.debug;
        platform.onAccessory(1, '99', '*1*1*99##');
        assert.ok(debugCalls.length > 0);
    });
});

describe('OwnPlatform config validation', () => {
    it('logs error and returns when host is missing', () => {
        const api = makeMockApi();
        const errors: unknown[][] = [];
        const log: Logging = {
            info: () => {},
            debug: () => {},
            warn: () => {},
            error: (...args: unknown[]) => { errors.push(args); },
        } as unknown as Logging;
        const platform = new OwnPlatform(log, { platform: 'MyHome', lights: [] }, api as unknown as API);
        assert.ok(errors.length > 0);
        assert.ok((errors[0][0] as string).includes('host'));
        assert.equal(platform.controller as unknown as undefined, undefined);
    });

    it('configureAccessory is safe when host is missing', () => {
        const api = makeMockApi();
        const log: Logging = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, success: () => {} } as unknown as Logging;
        const platform = new OwnPlatform(log, { platform: 'MyHome', lights: [] }, api as unknown as API);
        platform.configureAccessory({ displayName: 'test', UUID: 'test-uuid' } as unknown as PlatformAccessory);
    });

    it('starts normally when host is present', () => {
        const api = makeMockApi();
        (api as unknown as { on: (e: string, cb: () => void) => void }).on = () => {};
        const log: Logging = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, success: () => {} } as unknown as Logging;
        const platform = new OwnPlatform(log, { platform: 'MyHome', host: '127.0.0.1', password: '12345' }, api as unknown as API);
        assert.notEqual(platform.controller as unknown as undefined, undefined);
    });

    it('configureAccessory caches accessory but defers handler creation to discoverDevices', () => {
        const api = makeMockApi();
        (api as unknown as { on: (e: string, cb: () => void) => void }).on = () => {};
        const log: Logging = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, success: () => {} } as unknown as Logging;
        const platform = new OwnPlatform(log, { platform: 'MyHome', host: '127.0.0.1' }, api as unknown as API);
        const acc = makeAccessoryStub('Kitchen', api.hap.uuid.generate('myhome-light-42'));
        (acc as unknown as { context: Record<string, unknown> }).context = { type: 'light', device: { id: 42, name: 'Kitchen' } };
        platform.configureAccessory(acc);
        assert.equal(platform.cachedAccessories.length, 1, 'accessory must be cached');
        assert.equal(platform.activeHandlers.length, 0, 'handler creation deferred to discoverDevices');
    });
});

describe('constants', () => {
    it('PLUGIN_NAME matches npm package name', () => {
        assert.equal(PLUGIN_NAME, 'homebridge-myhome-unik');
    });

    it('PLUGIN_VERSION is valid semver', () => {
        assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+/);
    });
});

describe('OwnPlatform Matter lifecycle', () => {
    const config = { host: '127.0.0.1', lights: [{ id: 42, name: 'Kitchen' }] };
    const finish = (platform: OwnPlatform): Promise<void> => (platform as unknown as {
        finishDiscovery(ctrl: OwnClient): Promise<void>;
    }).finishDiscovery(platform.controller);

    function matterCache(api: MockApi, type: string, id: number, extra: Record<string, unknown> = {}): MatterAccessory {
        return {
            UUID: api.hap.uuid.generate(`myhome-${type}-${id}`), displayName: `Cached ${type}`,
            context: { deviceContext: { type, device: { id, ...extra }, blindPosition: 63 } },
        } as unknown as MatterAccessory;
    }

    it('publishes both protocols through the same device controller', async () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ ...config, expose: 'both' }, api);
        const reconciled: MatterDeviceEntry[][] = [];
        Object.assign(platform, { matterBridge: { sync: async (entries: MatterDeviceEntry[]) => { reconciled.push(entries); } } });
        platform.discoverDevices();
        await finish(platform);
        try {
            assert.equal(api.registered.length, 1);
            assert.equal(platform.activeHandlers.length, 1);
            assert.equal(reconciled[0][0].device, platform.activeHandlers[0]);
            platform.setAllOnline(true);
            platform.onMonitor('*1*1*42##');
            assert.equal(reconciled[0][0].device.snapshot().on, true);
            assert.equal(reconciled[0][0].device.snapshot().online, true);
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('keeps Matter-only controllers unpublished in HomeKit', async () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ ...config, expose: 'matter' }, api);
        let count = 0;
        Object.assign(platform, { matterBridge: { sync: async (entries: MatterDeviceEntry[]) => { count = entries.length; } } });
        platform.discoverDevices();
        await finish(platform);
        try {
            platform.updateAccessory(platform.activeHandlers[0].accessory);
            platform.discoverDevices();
            assert.equal(api.registered.length, 0);
            assert.equal(api.updated.length, 0);
            assert.equal(count, 1);
            assert.equal(platform.activeHandlers.length, 1);
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('restores blind position from the Matter cache without publishing HomeKit', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: config.host, expose: 'matter', blinds: [{ id: 23, time: 20, calibrateOnStart: false }],
        }, api);
        platform.configureMatterAccessory(matterCache(api, 'blind', 23, { time: 20, calibrateOnStart: false }));
        platform.discoverDevices();
        try {
            assert.equal(platform.activeHandlers[0].snapshot().position, 63);
            assert.equal(api.registered.length, 0);
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('prefers the HomeKit cache if both caches contain the same device', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ ...config, expose: 'both' }, api);
        platform.configureMatterAccessory(matterCache(api, 'light', 42));
        const hap = makeAccessoryStub('Kitchen', api.hap.uuid.generate('myhome-light-42'));
        platform.configureAccessory(hap);
        platform.discoverDevices();
        try {
            assert.equal(platform.cachedAccessories.length, 1);
            assert.equal(platform.activeHandlers.length, 1);
            assert.equal(platform.activeHandlers[0].accessory, hap);
            assert.equal(api.registered.length, 0);
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('publishes a cached Matter device once when switching to HomeKit', async () => {
        const api = makeMockApi();
        const platform = makePlatformInstance(config, api);
        const reconciled: MatterDeviceEntry[][] = [];
        Object.assign(platform, { matterBridge: {
            configureAccessory: () => {},
            sync: async (entries: MatterDeviceEntry[]) => { reconciled.push(entries); },
        } });
        platform.configureMatterAccessory(matterCache(api, 'light', 42));
        platform.discoverDevices();
        await finish(platform);
        try {
            platform.discoverDevices();
            assert.equal(api.registered.length, 1);
            assert.deepEqual(reconciled, [[]], 'previous Matter endpoints must be removed');
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('unpublishes the HomeKit accessory once when switching to Matter', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ ...config, expose: 'matter' }, api);
        const hap = makeAccessoryStub('Kitchen', api.hap.uuid.generate('myhome-light-42'));
        platform.configureAccessory(hap);
        platform.discoverDevices();
        try {
            platform.discoverDevices();
            assert.equal(api.unregistered.length, 1);
            assert.deepEqual(api.unregistered[0][2], [hap]);
            assert.equal(api.registered.length, 0);
            assert.equal(platform.activeHandlers.length, 1);
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('does not restart monitoring when shutdown occurs during Matter registration', async () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ ...config, expose: 'both' }, api);
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let started = false;
        platform.controller.startMonitor = () => { started = true; };
        Object.assign(platform, { matterBridge: { sync: () => pending } });
        platform.discoverDevices();
        const launching = finish(platform);
        Object.assign(platform, { stopped: true });
        release();
        await launching;
        try { assert.equal(started, false); } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('shutdown cancels an active scan without publishing its late discoveries', async t => {
        const api = makeMockApi();
        const callbacks = new Map<string, () => void>();
        api.on = (event, callback) => { callbacks.set(event, callback); };
        const platform = new OwnPlatform(makeMockPlatform().log, {
            platform: 'MyHome', ...config, expose: 'both', autoDiscover: true, autoDiscoverMaxAddr: 30,
        }, api as unknown as API);
        let matterDestroyed = false;
        let matterSyncs = 0;
        Object.assign(platform, { matterBridge: {
            destroy: () => { matterDestroyed = true; },
            sync: async () => { matterSyncs++; },
        } });
        const lifecycle = platform as unknown as { finishDiscovery(ctrl: OwnClient): Promise<void> };
        const finishDiscovery = lifecycle.finishDiscovery.bind(platform);
        let discovery: Promise<void> | undefined;
        lifecycle.finishDiscovery = controller => { discovery = finishDiscovery(controller); return discovery; };
        const controller = platform.controller;
        controller.detectGatewayModel = callback => callback(null);
        let monitorStarts = 0;
        controller.startMonitor = () => { monitorStarts++; };
        const connections: OwnConnection[] = [];
        controller.newConnection = mode => {
            const connection = new OwnConnection(controller.host, controller.port, controller.password, mode, controller.log);
            connection.connect = () => {
                connection.conn = new Socket();
                connection.state = STATE.CONNECTED;
                connection.emit('connected');
            };
            connection.sendPacket = () => {};
            connections.push(connection);
            return connection;
        };
        const shutdown = callbacks.get('shutdown')!;
        t.after(shutdown);
        callbacks.get('didFinishLaunching')!();
        assert.ok(discovery);
        assert.ok(controller.queueSize() > 0);
        // One device has replied, but most of this scan and its next batch remain pending.
        connections[0].onData('*1*1*1##' + PKT.ACK);
        const openedBeforeShutdown = connections.length;
        shutdown();
        await discovery;
        assert.equal(controller.activeCommands, 0);
        assert.equal(controller.queueSize(), 0);
        assert.equal(controller.sendCommand({ command: '*1*1*99##' }), false);
        assert.equal(connections.length, openedBeforeShutdown);
        assert.ok(connections.every(connection => connection.conn === null));
        assert.equal(platform.activeHandlers.length, 0);
        assert.equal(api.registered.length, 1, 'only the configured light was published before shutdown');
        assert.equal(matterDestroyed, true);
        assert.equal(matterSyncs, 0);
        assert.equal(monitorStarts, 0);
    });

    it('requires Matter to be enabled before selecting Matter-only mode', () => {
        const api = makeMockApi();
        assert.throws(() => new OwnPlatform(makeMockPlatform().log, {
            platform: 'MyHome', host: config.host, expose: 'matter',
        }, api as unknown as API), /enable Matter/);
    });
});

describe('OwnPlatform.autoDiscover', () => {
    function cacheLight(platform: OwnPlatform, api: MockApi, id: number): PlatformAccessory {
        const accessory = makeAccessoryStub(`Light ${id}`, api.hap.uuid.generate(`myhome-auto-1-${id}`));
        accessory.context = { autoDiscovered: true, autoWho: 1, autoId: id, type: 'light', device: { id } };
        platform.cachedAccessories.push(accessory);
        return accessory;
    }

    function scan(platform: OwnPlatform): Promise<void> {
        return (platform as unknown as { runAutoDiscovery(ctrl: OwnClient): Promise<void> })
            .runAutoDiscovery(platform.controller);
    }

    it('restores the HomeKit category and blind position from an auto-discovered Matter cache', async () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', autoDiscover: true, autoDiscoverMaxAddr: 1 }, api);
        platform.configureMatterAccessory({
            UUID: api.hap.uuid.generate('myhome-auto-2-23'), displayName: 'Blind 23',
            context: { deviceContext: {
                type: 'blind', device: { id: 23, time: 30, calibrateOnStart: false },
                autoDiscovered: true, autoWho: 2, autoId: 23, blindPosition: 63,
            } },
        } as unknown as MatterAccessory);
        platform.controller.sendCommand = params => { params.done?.(null, -1); return true; };
        platform.discoverDevices();
        await scan(platform);
        try {
            assert.equal(api.registered.length, 1);
            const [accessory] = api.registered[0][2] as PlatformAccessory[];
            assert.equal(accessory.category, 14, 'restored blind must use the WindowCovering category');
            assert.equal(platform.activeHandlers.length, 1);
            assert.equal(platform.activeHandlers[0].snapshot().position, 63);
            await scan(platform);
            assert.equal(api.registered.length, 1, 'a subsequent scan must reuse the published accessory');
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    for (const scanThrows of [false, true]) {
        it(`restores cached devices when the startup scan ${scanThrows ? 'throws' : 'gets no replies'}`, async () => {
            const api = makeMockApi();
            const platform = makePlatformInstance({ host: '127.0.0.1', autoDiscover: true, autoDiscoverMaxAddr: 1 }, api);
            const cached = cacheLight(platform, api, 5);
            platform.controller.sendCommand = params => {
                if (scanThrows) throw new Error('gateway unavailable');
                params.done?.(null, -1);
                return true;
            };
            platform.discoverDevices();
            await scan(platform);
            try {
                assert.equal(api.unregistered.length, 0);
                assert.equal(api.registered.length, 0);
                const handler = platform.activeHandlers.find(h => h.accessory === cached);
                assert.ok(handler instanceof OwnLightAccessory);
                platform.onMonitor('*1*1*5##');
                assert.equal(handler.value, true, 'returning device must receive monitor events');
            } finally {
                for (const handler of platform.activeHandlers) handler.destroy();
            }
        });
    }

    it('preserves distinct cached devices when a custom WHERE shares their id or prefix', async () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: '127.0.0.1', autoDiscover: true, autoDiscoverMaxAddr: 1,
            lights: [{ id: 7, where: '68#4#01' }],
        }, api);
        const cached = [cacheLight(platform, api, 7), cacheLight(platform, api, 68)];
        platform.controller.sendCommand = params => { params.done?.(null, -1); return true; };
        platform.discoverDevices();
        await scan(platform);
        try {
            assert.equal(api.unregistered.length, 0);
            for (const accessory of cached) {
                assert.ok(platform.activeHandlers.some(h => h.accessory === accessory));
                assert.ok(platform.cachedAccessories.includes(accessory));
            }
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('promotes only the exact effective address even when the scan fails', async () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: '127.0.0.1', autoDiscover: true, autoDiscoverMaxAddr: 1,
            lights: [{ id: 7, where: '15' }],
        }, api);
        const retained = cacheLight(platform, api, 7);
        const promoted = cacheLight(platform, api, 15);
        platform.controller.sendCommand = params => { params.done?.(null, -1); return true; };
        platform.discoverDevices();
        await scan(platform);
        try {
            assert.equal(api.unregistered.length, 1);
            assert.deepEqual(api.unregistered[0][2], [promoted]);
            assert.ok(platform.cachedAccessories.includes(retained));
            assert.ok(!platform.cachedAccessories.includes(promoted));
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('reuses a restored handler when its device also responds to the scan', async () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', autoDiscover: true, autoDiscoverMaxAddr: 1 }, api);
        const cached = cacheLight(platform, api, 1);
        platform.controller.sendCommand = params => {
            if (params.command === '*#1*1##') {
                params.packet?.('*1*1*1##');
                params.done?.('*#*1##', 0);
            } else {
                params.done?.(null, -1);
            }
            return true;
        };
        platform.discoverDevices();
        await scan(platform);
        try {
            assert.equal(platform.activeHandlers.filter(h => h.accessory === cached).length, 1);
            assert.equal(api.registered.length, 0);
            assert.equal(api.updated.length, 1);
        } finally {
            for (const handler of platform.activeHandlers) handler.destroy();
        }
    });

    it('registerAutoDiscoveredAccessory registers new light with placeholder name', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', autoDiscover: true }, api);
        platform.discoverDevices();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (platform as any).registerAutoDiscoveredAccessory(1, 5);
        assert.equal(api.registered.length, 1);
        const acc = api.registered[0]?.[2] as Array<{ displayName: string; context: Record<string, unknown> }>;
        assert.ok(acc?.[0]);
        assert.equal(acc[0].displayName, 'Light 5');
        assert.equal(acc[0].context.autoDiscovered, true);
        assert.equal(acc[0].context.autoWho, 1);
        assert.equal(acc[0].context.autoId, 5);
        for (const h of platform.activeHandlers) h.destroy();
    });

    it('registerAutoDiscoveredAccessory skips unknown WHO', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', autoDiscover: true }, api);
        platform.discoverDevices();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (platform as any).registerAutoDiscoveredAccessory(99, 5);
        assert.equal(api.registered.length, 0);
    });

    it('buildConfiguredAddrSet maps WHO to exact effective bus addresses', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            lights: [{ id: 3 }, { id: 7, where: '15' }, { id: 8, where: '68#4#01' }],
            blinds: [{ id: 2, time: 20 }],
        }, api);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const addrSet: Map<number, Set<string>> = (platform as any).buildConfiguredAddrSet();
        assert.deepEqual(addrSet.get(1), new Set(['3', '15', '68#4#01']));
        assert.deepEqual(addrSet.get(2), new Set(['2']));
    });

    it('discoverDevices preserves auto-discovered cached accessory when autoDiscover:true', () => {
        const api = makeMockApi();
        const autoUuid = api.hap.uuid.generate('myhome-auto-1-10');
        const autoAcc = makeAccessoryStub('Light 10', autoUuid);
        (autoAcc.context as Record<string, unknown>).autoDiscovered = true;
        (autoAcc.context as Record<string, unknown>).autoWho = 1;
        (autoAcc.context as Record<string, unknown>).autoId = 10;
        const platform = makePlatformInstance({ host: '127.0.0.1', autoDiscover: true }, api);
        platform.cachedAccessories.push(autoAcc);
        platform.discoverDevices();
        assert.ok(platform.cachedAccessories.includes(autoAcc), 'auto-discovered must be preserved');
        assert.equal(api.unregistered.length, 0);
    });

    it('discoverDevices removes auto-discovered cached accessory when autoDiscover:false', () => {
        const api = makeMockApi();
        const autoUuid = api.hap.uuid.generate('myhome-auto-1-10');
        const autoAcc = makeAccessoryStub('Light 10', autoUuid);
        (autoAcc.context as Record<string, unknown>).autoDiscovered = true;
        const platform = makePlatformInstance({ host: '127.0.0.1', autoDiscover: false }, api);
        platform.cachedAccessories.push(autoAcc);
        platform.discoverDevices();
        assert.ok(!platform.cachedAccessories.includes(autoAcc), 'auto-discovered must be removed when autoDiscover:false');
        assert.equal(api.unregistered.length, 1);
    });

    it('registerAutoDiscoveredAccessory re-attaches cached auto-discovered accessory', () => {
        const api = makeMockApi();
        const autoUuid = api.hap.uuid.generate('myhome-auto-1-5');
        const cachedAcc = makeAccessoryStub('Light 5', autoUuid);
        (cachedAcc.context as Record<string, unknown>).autoDiscovered = true;
        (cachedAcc.context as Record<string, unknown>).autoWho = 1;
        (cachedAcc.context as Record<string, unknown>).autoId = 5;
        const platform = makePlatformInstance({ host: '127.0.0.1', autoDiscover: true }, api);
        platform.cachedAccessories.push(cachedAcc);
        platform.discoverDevices();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isNew: boolean = (platform as any).registerAutoDiscoveredAccessory(1, 5);
        assert.equal(isNew, false, 'must return false for re-attached cached accessory');
        assert.equal(api.registered.length, 0, 'must not register again');
        assert.equal(api.updated.length, 1, 'must call updatePlatformAccessories');
        assert.equal(platform.activeHandlers.length, 1);
        for (const h of platform.activeHandlers) h.destroy();
    });
});
