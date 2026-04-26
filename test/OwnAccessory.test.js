'use strict';
var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var { makeMockPlatform, makeMockAccessory, POSITION_STATE, HEATING_COOLING_CURRENT, HEATING_COOLING_TARGET, CONTACT_STATE } = require('./helpers.js');
var OwnAccessory = require('../lib/OwnAccessory.js');

describe('OwnLightAccessory', function () {
    var platform, accessory, handler;
    beforeEach(function () {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnAccessory.OwnLightAccessory(platform, accessory, { id: 42, name: 'test-light' });
    });

    it('default name when none provided', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnLightAccessory(p, a, { id: 7 });
        assert.equal(h.name, 'light-7');
    });

    it('onData light off', function () {
        handler.value = true;
        handler.onData('*1*0*42##');
        assert.equal(handler.value, false);
    });

    it('onData light on', function () {
        handler.onData('*1*1*42##');
        assert.equal(handler.value, true);
    });

    it('onData dimmer level updates brightness', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnLightAccessory(p, a, { id: 42, name: 'dim', dimmer: true });
        h.onData('*1*5*42##');
        assert.equal(h.value, true);
        assert.equal(h.brightness, Math.round((5 - 2) / 8 * 100));
    });

    it('onData dimmer off', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnLightAccessory(p, a, { id: 42, name: 'dim', dimmer: true });
        h.onData('*1*0*42##');
        assert.equal(h.value, false);
    });

    it('onData unknown packet logs error', function () {
        var errors = [];
        platform.log.error = function () { errors.push(Array.from(arguments)); };
        handler.onData('*99*0*42##');
        assert.ok(errors.length > 0);
    });

    it('checkWhere matches id', function () {
        assert.ok(handler.checkWhere('42'));
        assert.ok(!handler.checkWhere('99'));
    });

    it('updateStatus sends status command', function () {
        handler.updateStatus();
        assert.ok(platform._sendCommandSpy.calls.length > 0);
        assert.ok(platform._sendCommandSpy.calls[0][0].command.includes('*#1*42'));
    });
});

describe('OwnBlindAccessory', function () {
    var platform, accessory, handler;
    beforeEach(function () {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnAccessory.OwnBlindAccessory(platform, accessory, { id: 23, name: 'test-blind', time: 30, timeSlat: 0, slatPercent: 0 });
    });

    it('default name when none provided', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnBlindAccessory(p, a, { id: 5, time: 20 });
        assert.equal(h.name, 'blind-5');
    });

    it('onData stop', function () {
        handler.position = 50;
        handler.target = 50;
        handler.onData('*2*0*23##');
        assert.equal(handler.state, POSITION_STATE.STOPPED);
        assert.equal(handler.position, 50);
    });

    it('onData stop snaps position when within 3', function () {
        handler.position = 48;
        handler.target = 50;
        handler.onData('*2*0*23##');
        assert.equal(handler.position, 50);
    });

    it('onData increasing', function () {
        handler.onData('*2*1*23##');
        assert.equal(handler.state, POSITION_STATE.INCREASING);
    });

    it('onData decreasing', function () {
        handler.onData('*2*2*23##');
        assert.equal(handler.state, POSITION_STATE.DECREASING);
    });

    it('unknown packet logs error', function () {
        var errors = [];
        platform.log.error = function () { errors.push(Array.from(arguments)); };
        handler.onData('*99*0*23##');
        assert.ok(errors.length > 0);
    });

    it('msPerPercent without slat', function () {
        assert.equal(handler.msPerPercent(50), (30 / 100) * 1000);
    });

    it('msPerPercent with slat in slat zone', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnBlindAccessory(p, a, { id: 1, name: 'v', time: 30, timeSlat: 5, slatPercent: 10 });
        var ms = h.msPerPercent(5);
        assert.equal(ms, Math.max(50, (5 / 10) * 1000));
    });

    it('msPerPercent with slat outside slat zone', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnBlindAccessory(p, a, { id: 1, name: 'v', time: 30, timeSlat: 5, slatPercent: 10 });
        var ms = h.msPerPercent(50);
        assert.equal(ms, (30 / 90) * 1000);
    });

    it('checkWhere matches', function () {
        assert.ok(handler.checkWhere('23'));
        assert.ok(!handler.checkWhere('99'));
    });

    it('destroy clears timeouts', function () {
        handler.moveTrackingTimeout = setTimeout(function () {}, 100000);
        handler.packetTimeout = setTimeout(function () {}, 100000);
        handler.positionTimeout = setTimeout(function () {}, 100000);
        handler.destroy();
        // No error thrown = timeouts cleared
    });
});

describe('OwnThermostatAccessory', function () {
    var platform, accessory, handler;
    beforeEach(function () {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnAccessory.OwnThermostatAccessory(platform, accessory, { id: 1, name: 'test-thermo', zone: 1 });
    });

    it('default name when none provided', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnThermostatAccessory(p, a, { id: 2, zone: 2 });
        assert.equal(h.name, 'thermostat-2');
    });

    it('onData current temperature', function () {
        handler.onData('*#4*1*0*0210##');
        assert.equal(handler.temperature, 21);
    });

    it('onData target temperature', function () {
        handler.onData('*#4*1*14*0180*3##');
        assert.equal(handler.targetTemperature, 18);
    });

    it('onData valve status sets heating', function () {
        handler.onData('*#4*1*19*0*1##');
        assert.equal(handler.heatingCoolingState, HEATING_COOLING_CURRENT.HEAT);
    });

    it('onData valve status sets cooling', function () {
        handler.onData('*#4*1*19*1*0##');
        assert.equal(handler.heatingCoolingState, HEATING_COOLING_CURRENT.COOL);
    });

    it('onData operation mode OFF', function () {
        handler.onData('*4*103*#0#1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.OFF);
    });

    it('onData manual heating with temperature', function () {
        handler.onData('*4*110#0180*#0#1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.HEAT);
        assert.equal(handler.targetTemperature, 18);
    });

    it('onData auto program', function () {
        handler.onData('*4*1101*#0#1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.AUTO);
    });

    it('onData antifreeze sets OFF', function () {
        handler.onData('*4*102*#0#1##');
        assert.equal(handler.targetHeatingCoolingState, HEATING_COOLING_TARGET.OFF);
    });

    it('checkWhere matches address', function () {
        assert.ok(handler.checkWhere('#0#1'));
    });

    it('checkWhere matches numeric id', function () {
        assert.ok(handler.checkWhere('1'));
    });

    it('checkWhere rejects non-matching', function () {
        assert.ok(!handler.checkWhere('99'));
    });
});

describe('OwnScenarioAccessory', function () {
    var platform, accessory, handler;
    beforeEach(function () {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnAccessory.OwnScenarioAccessory(platform, accessory, { id: 5, name: 'test-scenario' });
    });

    it('default name when none provided', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnScenarioAccessory(p, a, { id: 3 });
        assert.equal(h.name, 'scenario-3');
    });

    it('checkWhere always returns false', function () {
        assert.ok(!handler.checkWhere('5'));
        assert.ok(!handler.checkWhere('0'));
    });

    it('onData is a no-op', function () {
        handler.onData('*0*5*0##');
    });
});

describe('OwnContactAccessory', function () {
    var platform, accessory, handler;
    beforeEach(function () {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnAccessory.OwnContactAccessory(platform, accessory, { id: 55, name: 'test-contact' });
    });

    it('default name when none provided', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnContactAccessory(p, a, { id: 8 });
        assert.equal(h.name, 'contact-8');
    });

    it('onData contact detected', function () {
        handler.onData('*9*0*55##');
        assert.equal(handler.contactState, CONTACT_STATE.CONTACT_DETECTED);
    });

    it('onData contact not detected', function () {
        handler.onData('*9*1*55##');
        assert.equal(handler.contactState, CONTACT_STATE.CONTACT_NOT_DETECTED);
    });

    it('unknown packet logs error', function () {
        var errors = [];
        platform.log.error = function () { errors.push(Array.from(arguments)); };
        handler.onData('*99*0*55##');
        assert.ok(errors.length > 0);
    });

    it('checkWhere matches', function () {
        assert.ok(handler.checkWhere('55'));
        assert.ok(!handler.checkWhere('99'));
    });

    it('updateStatus sends command', function () {
        handler.updateStatus();
        assert.ok(platform._sendCommandSpy.calls.length > 0);
        assert.ok(platform._sendCommandSpy.calls[0][0].command.includes('*#9*55'));
    });
});

describe('OwnEnergyAccessory', function () {
    var platform, accessory, handler;
    beforeEach(function () {
        platform = makeMockPlatform();
        accessory = makeMockAccessory();
        accessory.addService('AccessoryInformation');
        handler = new OwnAccessory.OwnEnergyAccessory(platform, accessory, { id: 71, name: 'test-energy' });
    });
    afterEach(function () {
        handler.destroy();
    });

    it('default name when none provided', function () {
        var p = makeMockPlatform();
        var a = makeMockAccessory();
        a.addService('AccessoryInformation');
        var h = new OwnAccessory.OwnEnergyAccessory(p, a, { id: 9 });
        assert.equal(h.name, 'energy-9');
        h.destroy();
    });

    it('onData sets watts', function () {
        handler.onData('*#18*71*113*350##');
        assert.equal(handler.watts, 350);
    });

    it('onData zero watts floors to 0.0001', function () {
        handler.onData('*#18*71*113*0##');
        assert.equal(handler.watts, 0.0001);
    });

    it('non-113 dimension packet is ignored', function () {
        handler.watts = 100;
        handler.onData('*#18*71*112*999##');
        assert.equal(handler.watts, 100);
    });

    it('updateStatus sends command', function () {
        handler.updateStatus();
        assert.ok(platform._sendCommandSpy.calls.length > 0);
        assert.ok(platform._sendCommandSpy.calls[0][0].command.includes('*#18*71*113'));
    });

    it('destroy clears interval', function () {
        handler.destroy();
    });

    it('checkWhere matches', function () {
        assert.ok(handler.checkWhere('71'));
        assert.ok(!handler.checkWhere('99'));
    });
});
