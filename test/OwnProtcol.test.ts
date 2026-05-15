import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OwnProtcol, WHO } from '../lib/OwnProtcol';

describe('getWhoType', () => {
    const known: [number, number][] = [
        [0, WHO.scenario], [1, WHO.light], [2, WHO.automation], [3, WHO.load],
        [4, WHO.temperature], [5, WHO.alarm], [7, WHO.videoDoor], [9, WHO.auxiliary],
        [13, WHO.gateway], [15, WHO.CEN], [16, WHO.soundSystem], [17, WHO.scene],
        [18, WHO.energy], [22, WHO.soundDiffusion], [25, WHO.CEN],
        [1000, WHO.diagnostic], [1001, WHO.autoDiagnostic],
        [1004, WHO.heatingDiagnostic], [1013, WHO.deviceDiagnostic],
    ];
    for (const [code, expected] of known) {
        it(`maps ${code} to ${expected}`, () => {
            assert.equal(OwnProtcol.getWhoType(String(code)), expected);
        });
    }
    it('returns null for unknown code', () => {
        assert.equal(OwnProtcol.getWhoType('999'), null);
    });
});

describe('getStatus', () => {
    it('light off', () => { assert.equal(OwnProtcol.getStatus('1', '0'), false); });
    it('light on', () => { assert.equal(OwnProtcol.getStatus('1', '1'), true); });
    it('light unknown level returns null', () => { assert.equal(OwnProtcol.getStatus('1', '5'), null); });
    it('automation returns integer', () => { assert.equal(OwnProtcol.getStatus('2', '1'), 1); });
    it('temperature divides by 10', () => { assert.equal(OwnProtcol.getStatus('4', '210'), 21); });
    it('unknown who returns null', () => { assert.equal(OwnProtcol.getStatus('99', '0'), null); });
});

describe('parseStatus', () => {
    it('parses light on', () => {
        const r = OwnProtcol.parseStatus('*1*1*42##');
        assert.deepEqual(r, { type: WHO.light, id: 42, status: true });
    });
    it('parses light off', () => {
        const r = OwnProtcol.parseStatus('*1*0*42##');
        assert.deepEqual(r, { type: WHO.light, id: 42, status: false });
    });
    it('parses automation', () => {
        const r = OwnProtcol.parseStatus('*2*1*23##');
        assert.deepEqual(r, { type: WHO.automation, id: 23, status: 1 });
    });
    it('parses temperature', () => {
        const r = OwnProtcol.parseStatus('*#4*1*0*0210##');
        assert.deepEqual(r, { type: WHO.temperature, id: 1, status: 21 });
    });
    it('returns empty object for non-string', () => {
        assert.deepEqual(OwnProtcol.parseStatus(null), {});
    });
    it('returns empty object for malformed', () => {
        assert.deepEqual(OwnProtcol.parseStatus('garbage'), {});
    });
});

describe('parseWHO', () => {
    it('parses *WHO*..## form', () => {
        assert.equal(OwnProtcol.parseWHO('*1*1*42##'), WHO.light);
    });
    it('parses *#WHO*..## form', () => {
        assert.equal(OwnProtcol.parseWHO('*#4*1*0*0210##'), WHO.temperature);
    });
    it('returns null for unrecognized', () => {
        assert.equal(OwnProtcol.parseWHO('garbage'), null);
    });
});

describe('parseWhere', () => {
    it('parses *W*X*WHERE## form', () => {
        assert.equal(OwnProtcol.parseWhere('*1*1*42##'), '42');
    });
    it('parses *#W*WHERE*..## form', () => {
        assert.equal(OwnProtcol.parseWhere('*#4*1*0*0210##'), '1');
    });
    it('parses where with hash', () => {
        assert.equal(OwnProtcol.parseWhere('*#4*#0#1*14*0210*3##'), '#0#1');
    });
    it('returns null for malformed', () => {
        assert.equal(OwnProtcol.parseWhere('garbage'), null);
    });
});

describe('extractPacketInfo', () => {
    it('extracts from command form', () => {
        const r = OwnProtcol.extractPacketInfo('*1*1*42##');
        assert.deepEqual(r, { who: WHO.light, where: '42' });
    });
    it('extracts from dimension form', () => {
        const r = OwnProtcol.extractPacketInfo('*#4*1*0*0210##');
        assert.deepEqual(r, { who: WHO.temperature, where: '1' });
    });
    it('returns nulls for malformed', () => {
        const r = OwnProtcol.extractPacketInfo('garbage');
        assert.deepEqual(r, { who: null, where: null });
    });
});

describe('decodeTemperature', () => {
    it('decodes positive', () => { assert.equal(OwnProtcol.decodeTemperature('0210'), 21); });
    it('decodes negative', () => { assert.equal(OwnProtcol.decodeTemperature('1035'), -3.5); });
    it('decodes small positive', () => { assert.equal(OwnProtcol.decodeTemperature('0001'), 0.1); });
    it('returns 0 for malformed', () => { assert.equal(OwnProtcol.decodeTemperature('xx'), 0); });
});

describe('encodeTemperature', () => {
    it('encodes positive', () => { assert.equal(OwnProtcol.encodeTemperature(21), '0210'); });
    it('encodes negative', () => { assert.equal(OwnProtcol.encodeTemperature(-3.5), '1035'); });
    it('encodes zero', () => { assert.equal(OwnProtcol.encodeTemperature(0), '0000'); });
});

describe('temperature round-trip', () => {
    for (let t = -50; t <= 50; t += 0.1) {
        const rounded = Math.round(t * 10) / 10;
        ((temp: number) => {
            it(`round-trips ${temp}`, () => {
                assert.equal(OwnProtcol.decodeTemperature(OwnProtcol.encodeTemperature(temp)), temp);
            });
        })(rounded);
    }
});
