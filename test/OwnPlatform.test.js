'use strict';
var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var { makeMockPlatform, makeSpy } = require('./helpers.js');
var OwnAccessory = require('../lib/OwnAccessory.js');
var OwnProtcol = require('../lib/OwnProtcol.js');

function makeMockApi() {
    var registered = [];
    var updated = [];
    var unregistered = [];
    return {
        hap: {
            uuid: { generate: function (s) { return 'uuid-' + s; } },
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
        on: function (event, cb) { if (event === 'didFinishLaunching') cb(); },
        platformAccessory: function (name, uuid) {
            var services = {};
            var acc = {
                displayName: name,
                UUID: uuid,
                context: {},
                getService: function (svc) { return services[svc] || null; },
                addService: function (svc) {
                    var chars = {};
                    services[svc] = {
                        getCharacteristic: function (c) {
                            if (!chars[c]) chars[c] = {
                                _value: undefined,
                                onGet: function () { return this; },
                                onSet: function () { return this; },
                                setProps: function () { return this; },
                                updateValue: function (v) { this._value = v; return this; },
                                setCharacteristic: function () { return this; },
                            };
                            return chars[c];
                        },
                        setCharacteristic: function () { return this; },
                    };
                    return services[svc];
                },
            };
            acc.addService('AccessoryInformation');
            return acc;
        },
        registerPlatformAccessories: function () { registered.push(Array.from(arguments)); },
        updatePlatformAccessories: function () { updated.push(Array.from(arguments)); },
        unregisterPlatformAccessories: function () { unregistered.push(Array.from(arguments)); },
        _registered: registered,
        _updated: updated,
        _unregistered: unregistered,
    };
}

function makePlatformInstance(config, api) {
    var defaults = require('lodash');
    var PLUGIN_NAME = 'homebridge-myhome';
    var PLATFORM_NAME = 'MyHome';

    var defaultConfig = { port: 20000, lights: [], blinds: [], thermostats: [], scenarios: [], contacts: [], energies: [] };
    var mergedConfig = defaults.defaults(config, defaultConfig);

    var log = { info: function () {}, debug: function () {}, warn: function () {}, error: function () {} };

    var platform = {
        config: mergedConfig,
        log: log,
        api: api,
        Service: api.hap.Service,
        Characteristic: api.hap.Characteristic,
        cachedAccessories: [],
        activeHandlers: [],
        controller: { sendCommand: makeSpy(), on: function () {}, startMonitor: function () {} },
    };

    var OwnPlatform = require('../lib/OwnPlatform.js').OwnPlatform;
    platform.discoverDevices = OwnPlatform.prototype.discoverDevices.bind(platform);
    platform.createHandler = OwnPlatform.prototype.createHandler.bind(platform);
    platform.onMonitor = OwnPlatform.prototype.onMonitor.bind(platform);
    platform.onAccessory = OwnPlatform.prototype.onAccessory.bind(platform);

    return platform;
}

describe('OwnPlatform.discoverDevices', function () {
    it('registers new light accessory', function () {
        var api = makeMockApi();
        var platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'Kitchen' }] }, api);
        platform.discoverDevices();
        assert.equal(api._registered.length, 1);
        assert.equal(platform.activeHandlers.length, 1);
    });

    it('updates cached accessory', function () {
        var api = makeMockApi();
        var uuid = api.hap.uuid.generate('myhome-light-42');
        var cachedAcc = new api.platformAccessory('Old', uuid);
        var platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'Kitchen' }] }, api);
        platform.cachedAccessories.push(cachedAcc);
        platform.discoverDevices();
        assert.equal(api._registered.length, 0);
        assert.equal(api._updated.length, 1);
        assert.equal(platform.activeHandlers.length, 1);
    });

    it('removes stale cached accessory', function () {
        var api = makeMockApi();
        var staleAcc = new api.platformAccessory('Stale', 'uuid-stale');
        var platform = makePlatformInstance({ host: '127.0.0.1', lights: [] }, api);
        platform.cachedAccessories.push(staleAcc);
        platform.discoverDevices();
        assert.equal(api._unregistered.length, 1);
    });

    it('creates correct handler types', function () {
        var api = makeMockApi();
        var platform = makePlatformInstance({
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
        assert.equal(api._registered.length, 6);
        for (var h of platform.activeHandlers) h.destroy();
    });

    it('destroys handler on stale removal', function () {
        var api = makeMockApi();
        var staleAcc = new api.platformAccessory('Stale', 'uuid-stale');
        var destroyed = false;
        var platform = makePlatformInstance({ host: '127.0.0.1', lights: [] }, api);
        platform.cachedAccessories.push(staleAcc);
        platform.activeHandlers.push({
            accessory: staleAcc,
            destroy: function () { destroyed = true; },
        });
        platform.discoverDevices();
        assert.ok(destroyed);
        assert.equal(platform.activeHandlers.length, 0);
    });
});

describe('OwnPlatform.onMonitor', function () {
    it('routes light packet to onAccessory', function () {
        var api = makeMockApi();
        var platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'L' }] }, api);
        platform.discoverDevices();
        var called = false;
        var origOnData = platform.activeHandlers[0].onData;
        platform.activeHandlers[0].onData = function (p) { called = true; };
        platform.onMonitor('*1*1*42##');
        assert.ok(called);
    });

    it('logs debug for gateway packet', function () {
        var api = makeMockApi();
        var platform = makePlatformInstance({ host: '127.0.0.1' }, api);
        var debugCalls = [];
        platform.log.debug = function () { debugCalls.push(Array.from(arguments)); };
        platform.onMonitor('*13*1*0##');
        assert.ok(debugCalls.length > 0);
    });

    it('logs debug for unknown WHO', function () {
        var api = makeMockApi();
        var platform = makePlatformInstance({ host: '127.0.0.1' }, api);
        var debugCalls = [];
        platform.log.debug = function () { debugCalls.push(Array.from(arguments)); };
        platform.onMonitor('*16*1*0##');
        assert.ok(debugCalls.length > 0);
    });
});

describe('OwnPlatform.onAccessory', function () {
    it('dispatches to matching handler', function () {
        var api = makeMockApi();
        var platform = makePlatformInstance({ host: '127.0.0.1', lights: [{ id: 42, name: 'L' }] }, api);
        platform.discoverDevices();
        var received = null;
        platform.activeHandlers[0].onData = function (p) { received = p; };
        platform.onAccessory('42', '*1*1*42##');
        assert.equal(received, '*1*1*42##');
    });

    it('logs debug for unmatched where', function () {
        var api = makeMockApi();
        var platform = makePlatformInstance({ host: '127.0.0.1' }, api);
        var debugCalls = [];
        platform.log.debug = function () { debugCalls.push(Array.from(arguments)); };
        platform.onAccessory('99', '*1*1*99##');
        assert.ok(debugCalls.length > 0);
    });
});
