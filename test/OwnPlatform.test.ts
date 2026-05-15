import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
            getCharacteristic: (c: string) => {
                if (!chars[c]) chars[c] = makeCharStub();
                return chars[c];
            },
            setCharacteristic: () => services[svc],
        };
        return services[svc];
    }
    addSvc('AccessoryInformation');
    return {
        displayName: name,
        UUID: uuid,
        context: {},
        getService: (svc: string) => services[svc] ?? null,
        addService: (svc: string) => addSvc(svc),
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
                LightSensor: 'LightSensor',
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

    const log: Logging = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logging;

    const platform = {
        config: mergedConfig,
        log: log,
        api: api as unknown as API,
        Service: api.hap.Service,
        Characteristic: api.hap.Characteristic,
        HapStatusError: function (this: { code: number }, code: number) { this.code = code; } as unknown as new (status: number) => Error,
        cachedAccessories: [] as PlatformAccessory[],
        activeHandlers: [],
        controller: { sendCommand: makeSpy(), on: () => {}, startMonitor: () => {}, commandQueue: [] as unknown[], queueSize: () => 0 },
    };

    const p = platform as unknown as OwnPlatform;
    p.discoverDevices = OwnPlatform.prototype.discoverDevices.bind(p);
    p.createHandler = OwnPlatform.prototype.createHandler.bind(p);
    p.onMonitor = OwnPlatform.prototype.onMonitor.bind(p);
    p.onAccessory = OwnPlatform.prototype.onAccessory.bind(p);

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
        platform.onMonitor('*16*1*0##');
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
});

describe('OwnPlatform.onAccessory', () => {
    it('dispatches to matching handler', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'L' }] }, api);
        platform.discoverDevices();
        let received: string | null = null;
        platform.activeHandlers[0].onData = (p: string) => { received = p; };
        platform.onAccessory('42', '*1*1*42##');
        assert.equal(received, '*1*1*42##');
    });

    it('logs debug for unmatched where', () => {
        const api = makeMockApi();
        const platform = makePlatformInstance({ host: '127.0.0.1' }, api);
        const debugCalls: unknown[][] = [];
        platform.log.debug = function (...args: unknown[]) { debugCalls.push(args); } as typeof platform.log.debug;
        platform.onAccessory('99', '*1*1*99##');
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
        const log: Logging = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logging;
        const platform = new OwnPlatform(log, { platform: 'MyHome', lights: [] }, api as unknown as API);
        platform.configureAccessory({ displayName: 'test', UUID: 'test-uuid' } as unknown as PlatformAccessory);
    });

    it('starts normally when host is present', () => {
        const api = makeMockApi();
        (api as unknown as { on: (e: string, cb: () => void) => void }).on = () => {};
        const log: Logging = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as unknown as Logging;
        const platform = new OwnPlatform(log, { platform: 'MyHome', host: '127.0.0.1', password: '12345' }, api as unknown as API);
        assert.notEqual(platform.controller as unknown as undefined, undefined);
    });
});

describe('constants', () => {
    it('PLUGIN_NAME matches npm package name', () => {
        assert.equal(PLUGIN_NAME, 'homebridge-myhome-unik');
    });
});
