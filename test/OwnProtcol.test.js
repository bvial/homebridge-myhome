'use strict';
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var { OwnProtcol, WHO } = require('../lib/OwnProtcol.js');

describe('getWhoType', function () {
    var known = [
        [0, WHO.scenario], [1, WHO.light], [2, WHO.automation], [3, WHO.load],
        [4, WHO.temperature], [5, WHO.alarm], [7, WHO.video_door], [9, WHO.auxiliary],
        [13, WHO.gateway], [15, WHO.CEN], [16, WHO.sound_system], [17, WHO.scene],
        [18, WHO.energy], [22, WHO.sound_diffusion], [25, WHO.CEN],
        [1000, WHO.diagnostic], [1001, WHO.auto_diagnostic],
        [1004, WHO.heating_diagnostic], [1013, WHO.device_diagnostic],
    ];
    for (var [code, expected] of known) {
        it('maps ' + code + ' to ' + expected, function () {
            assert.equal(OwnProtcol.getWhoType(String(code)), expected);
        });
    }
    it('returns null for unknown code', function () {
        assert.equal(OwnProtcol.getWhoType('999'), null);
    });
});

describe('getStatus', function () {
    it('light off', function () { assert.equal(OwnProtcol.getStatus('1', '0'), false); });
    it('light on', function () { assert.equal(OwnProtcol.getStatus('1', '1'), true); });
    it('light unknown level returns null', function () { assert.equal(OwnProtcol.getStatus('1', '5'), null); });
    it('automation returns integer', function () { assert.equal(OwnProtcol.getStatus('2', '1'), 1); });
    it('temperature divides by 10', function () { assert.equal(OwnProtcol.getStatus('4', '210'), 21); });
    it('unknown who returns null', function () { assert.equal(OwnProtcol.getStatus('99', '0'), null); });
});

describe('parseStatus', function () {
    it('parses light on', function () {
        var r = OwnProtcol.parseStatus('*1*1*42##');
        assert.deepEqual(r, { type: WHO.light, id: 42, status: true });
    });
    it('parses light off', function () {
        var r = OwnProtcol.parseStatus('*1*0*42##');
        assert.deepEqual(r, { type: WHO.light, id: 42, status: false });
    });
    it('parses automation', function () {
        var r = OwnProtcol.parseStatus('*2*1*23##');
        assert.deepEqual(r, { type: WHO.automation, id: 23, status: 1 });
    });
    it('parses temperature', function () {
        var r = OwnProtcol.parseStatus('*#4*1*0*0210##');
        assert.deepEqual(r, { type: WHO.temperature, id: 1, status: 21 });
    });
    it('returns empty object for non-string', function () {
        assert.deepEqual(OwnProtcol.parseStatus(null), {});
    });
    it('returns empty object for malformed', function () {
        assert.deepEqual(OwnProtcol.parseStatus('garbage'), {});
    });
});

describe('parseWHO', function () {
    it('parses *WHO*..## form', function () {
        assert.equal(OwnProtcol.parseWHO('*1*1*42##'), WHO.light);
    });
    it('parses *#WHO*..## form', function () {
        assert.equal(OwnProtcol.parseWHO('*#4*1*0*0210##'), WHO.temperature);
    });
    it('returns null for unrecognized', function () {
        assert.equal(OwnProtcol.parseWHO('garbage'), null);
    });
});

describe('parseWhere', function () {
    it('parses *W*X*WHERE## form', function () {
        assert.equal(OwnProtcol.parseWhere('*1*1*42##'), '42');
    });
    it('parses *#W*WHERE*..## form', function () {
        assert.equal(OwnProtcol.parseWhere('*#4*1*0*0210##'), '1');
    });
    it('parses where with hash', function () {
        assert.equal(OwnProtcol.parseWhere('*#4*#0#1*14*0210*3##'), '#0#1');
    });
    it('returns null for malformed', function () {
        assert.equal(OwnProtcol.parseWhere('garbage'), null);
    });
});

describe('extractPacketInfo', function () {
    it('extracts from command form', function () {
        var r = OwnProtcol.extractPacketInfo('*1*1*42##');
        assert.deepEqual(r, { who: WHO.light, where: '42' });
    });
    it('extracts from dimension form', function () {
        var r = OwnProtcol.extractPacketInfo('*#4*1*0*0210##');
        assert.deepEqual(r, { who: WHO.temperature, where: '1' });
    });
    it('returns nulls for malformed', function () {
        var r = OwnProtcol.extractPacketInfo('garbage');
        assert.deepEqual(r, { who: null, where: null });
    });
});

describe('decodeTemperature', function () {
    it('decodes positive', function () { assert.equal(OwnProtcol.decodeTemperature('0210'), 21); });
    it('decodes negative', function () { assert.equal(OwnProtcol.decodeTemperature('1035'), -3.5); });
    it('decodes small positive', function () { assert.equal(OwnProtcol.decodeTemperature('0001'), 0.1); });
    it('returns 0 for malformed', function () { assert.equal(OwnProtcol.decodeTemperature('xx'), 0); });
});

describe('encodeTemperature', function () {
    it('encodes positive', function () { assert.equal(OwnProtcol.encodeTemperature(21), '0210'); });
    it('encodes negative', function () { assert.equal(OwnProtcol.encodeTemperature(-3.5), '1035'); });
    it('encodes zero', function () { assert.equal(OwnProtcol.encodeTemperature(0), '0000'); });
});

describe('temperature round-trip', function () {
    for (var t = -50; t <= 50; t += 0.1) {
        var rounded = Math.round(t * 10) / 10;
        (function (temp) {
            it('round-trips ' + temp, function () {
                assert.equal(OwnProtcol.decodeTemperature(OwnProtcol.encodeTemperature(temp)), temp);
            });
        })(rounded);
    }
});
