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
