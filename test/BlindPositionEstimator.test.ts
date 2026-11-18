import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BlindPositionEstimator } from '../lib/BlindPositionEstimator';

describe('BlindPositionEstimator', () => {
    const timing = { timeUp: 20, timeDown: 25, timeSlat: 0, slatPercent: 0 };
    it('integrates elapsed time, not the number of callbacks', () => {
        const estimate = new BlindPositionEstimator(timing, 50);
        estimate.start('opening', 1000);
        assert.equal(estimate.position(1000), 50);
        assert.ok(Math.abs(estimate.position(2000) - 55) < 1e-9);
        assert.equal(estimate.position(7000), 80);
        estimate.stop(7250);
        assert.equal(estimate.position(10000), 81.25);
    });
    it('preserves fractional position and uses the other duration on reversal', () => {
        const estimate = new BlindPositionEstimator(timing, 50);
        estimate.start('opening', 0);
        estimate.start('closing', 125);
        assert.equal(estimate.position(250), 50.125);
        estimate.start('closing', 250); // duplicate event does not reset the anchor
        assert.equal(estimate.position(500), 49.125);
    });
    it('integrates both sides of the slat boundary even in a single delayed callback', () => {
        const estimate = new BlindPositionEstimator({ ...timing, timeSlat: 5, slatPercent: 10 }, 0);
        estimate.start('opening', 0);
        assert.equal(estimate.position(2500), 5);
        assert.equal(estimate.position(5000), 10);
        assert.equal(estimate.position(15000), 55);
        assert.equal(estimate.remaining(100, 15000), 10000);
        estimate.start('closing', 25000);
        assert.equal(estimate.position(50000), 10);
        assert.equal(estimate.position(52500), 5);
    });
    it('keeps estimates finite and bounded through many direction changes and long delays', () => {
        const estimate = new BlindPositionEstimator(timing, 50);
        let now = 0;
        for (let i = 0; i < 500; i++) {
            estimate.start(i % 2 ? 'opening' : 'closing', now);
            now += (i * 137) % 30000;
            const position = estimate.position(now);
            assert.ok(Number.isFinite(position) && position >= 0 && position <= 100);
        }
        estimate.start('opening', now);
        assert.equal(estimate.position(now + 100000), 100);
    });
});
