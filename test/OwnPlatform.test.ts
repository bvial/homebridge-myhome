import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeMockPlatform, makeSpy } from './helpers';
import { OwnPlatform } from '../lib/OwnPlatform';
import { PLUGIN_NAME } from '../lib/constants';
import type { API, Logging, PlatformAccessory } from 'homebridge';

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
    const defaultConfig = { port: 20000, lights: [], blinds: [], thermostats: [], scenarios: [], contacts: [], energies: [] };
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
        controller: Object.assign(new EventEmitter(), { sendCommand: makeSpy(), startMonitor: () => {}, commandQueue: [] as unknown[], queueSize: () => 0 }),
    };

    const p = platform as unknown as OwnPlatform;
    p.discoverDevices = OwnPlatform.prototype.discoverDevices.bind(p);
    p.createHandler = OwnPlatform.prototype.createHandler.bind(p);
    p.onMonitor = OwnPlatform.prototype.onMonitor.bind(p);
    p.onAccessory = OwnPlatform.prototype.onAccessory.bind(p);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).buildConfiguredAddrSet = (OwnPlatform.prototype as any).buildConfiguredAddrSet.bind(p);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).registerAutoDiscoveredAccessory = (OwnPlatform.prototype as any).registerAutoDiscoveredAccessory.bind(p);

    return p;
}

describe('OwnPlatform.discoverDevices', () => {
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
});

describe('OwnPlatform.autoDiscover', () => {
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

    it('buildConfiguredAddrSet maps WHO to configured ids', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({
            host: '127.0.0.1',
            lights: [{ id: 3 }, { id: 7 }],
            blinds: [{ id: 2, time: 20 }],
        }, api);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const addrSet: Map<number, Set<number>> = (platform as any).buildConfiguredAddrSet();
        assert.ok(addrSet.get(1)?.has(3));
        assert.ok(addrSet.get(1)?.has(7));
        assert.ok(addrSet.get(2)?.has(2));
        assert.ok(!addrSet.get(1)?.has(10));
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
