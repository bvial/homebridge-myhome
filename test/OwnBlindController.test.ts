import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { OwnBlindController, BlindError, type BlindConfig, type BlindState } from '../lib/OwnBlindController';
import { makeMockClient, makeMockPlatform } from './helpers';
import { PKT } from '../lib/OwnNet';

async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function approximately(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should be close to ${expected}`); }
function fixture(t: TestContext, config: Partial<BlindConfig> = {}, context: Record<string, unknown> = { blindPosition: 50 }, connectImmediately = true) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const network = makeMockClient(makeMockPlatform().log, connectImmediately);
    const events: Array<{ state: BlindState; persist?: string }> = [];
    const blind = new OwnBlindController(network.client, network.client.log,
        { id: 2, time: 20, calibrateOnStart: false, ...config }, context,
        (state, persist) => events.push({ state, persist }), { now: () => Date.now() });
    blind.setOnline(true);
    t.after(async () => { blind.destroy(); network.client.destroy(); await settle(); });
    const track = (p: Promise<void>) => { void p.catch(() => {}); return p; };
    return { ...network, blind, events,
        move: (target: number) => track(blind.moveTo(target)),
        stop: () => track(blind.stop()),
        calibrate: () => track(blind.calibrate()),
        ack: async (index: number) => { network.connections[index].onData(PKT.ACK); await settle(); },
        tick: async (ms: number) => { t.mock.timers.tick(ms); await settle(); },
    };
}

describe('OwnBlindController', () => {
    it('does not move the estimate before motion and catches up after delayed callbacks', async t => {
        const f = fixture(t);
        const accepted = f.move(80);
        assert.equal(f.blind.snapshot().position, 50);
        await f.ack(0); await accepted;
        assert.equal(f.blind.snapshot().position, 50);
        await f.tick(1000);
        approximately(f.blind.snapshot().position, 55);
        f.blind.onData('*2*1*2##'); // duplicate direction echo must not reset the origin
        await f.tick(1000);
        assert.equal(f.blind.snapshot().position, 60);
    });

    it('keeps estimating during a queued STOP and retains actual overshoot', async t => {
        const f = fixture(t); f.client.maxConcurrent = 1;
        const accepted = f.move(80);
        await f.ack(0); await accepted;
        f.client.sendCommand({ command: '*#1*9##' }); // occupy the TCP slot
        await f.tick(6000);
        assert.equal(f.blind.snapshot().blindPhase, 'stopping');
        assert.equal(f.connections.length, 2);
        await f.tick(1000);
        assert.equal(f.blind.snapshot().position, 85);
        await f.ack(1); // STOP only reaches the bus now
        assert.equal(f.sent[2], '*2*0*2##');
        await f.ack(2);
        assert.equal(f.blind.snapshot().position, 85);
        assert.equal(f.blind.snapshot().targetPosition, 85);
        assert.equal(f.blind.snapshot().moving, 'stopped');
    });

    it('preserves the latest target when reversing before the first echo', async t => {
        const f = fixture(t);
        const first = f.move(80);
        const second = f.move(20);
        await assert.rejects(first, (e: unknown) => e instanceof BlindError && e.code === 'cancelled');
        f.blind.onData('*2*1*2##');
        await f.ack(0);
        assert.deepEqual(f.sent, ['*2*1*2##', '*2*0*2##']);
        f.blind.onData('*2*0*2##');
        await f.ack(1);
        assert.deepEqual(f.sent, ['*2*1*2##', '*2*0*2##', '*2*2*2##']);
        f.blind.onData('*2*2*2##');
        await f.ack(2); await second;
        assert.equal(f.blind.snapshot().targetPosition, 20);
        await f.tick(6000);
        assert.equal(f.sent[3], '*2*0*2##');
        await f.ack(3);
        assert.equal(f.blind.snapshot().position, 20);
        await f.tick(2000);
        assert.equal(f.sent.length, 4);
    });

    for (const ackFirst of [false, true]) {
        it(`ignores an old reversal STOP echo ${ackFirst ? 'after' : 'before'} the DOWN ACK`, async t => {
            const f = fixture(t);
            const up = f.move(80);
            f.blind.onData('*2*1*2##'); await f.ack(0); await up;
            await f.tick(1000);
            const down = f.move(20);
            await f.ack(1); // reversal STOP confirmed without its monitor echo
            assert.equal(f.sent[2], '*2*2*2##');
            if (ackFirst) await f.ack(2);
            await f.tick(100);
            f.blind.onData('*2*0*2##'); // STOP belongs to the previous transmission
            if (!ackFirst) await f.ack(2);
            await down;
            assert.equal(f.blind.snapshot().moving, 'closing');
            assert.equal(f.blind.snapshot().blindPhase, 'moving');
            assert.equal(f.blind.snapshot().targetPosition, 20);
            approximately(f.blind.snapshot().position, 54.5);
            await f.tick(6900);
            assert.deepEqual(f.sent, ['*2*1*2##', '*2*0*2##', '*2*2*2##', '*2*0*2##']);
            await f.ack(3);
            assert.equal(f.blind.snapshot().moving, 'stopped');
            approximately(f.blind.snapshot().position, 20);
        });

        it(`keeps STOP authoritative when an old UP echo arrives ${ackFirst ? 'after' : 'before'} its ACK`, async t => {
            const f = fixture(t);
            const up = f.move(80); await f.ack(0); await up;
            await f.tick(100);
            const stop = f.stop();
            if (ackFirst) await f.ack(1);
            f.blind.onData('*2*1*2##');
            if (!ackFirst) await f.ack(1);
            await stop;
            assert.equal(f.blind.snapshot().moving, 'stopped');
            assert.equal(f.blind.snapshot().blindPhase, 'idle');
            await f.tick(1000);
            approximately(f.blind.snapshot().position, 50.5);
            assert.equal(f.sent.length, 2);
        });
    }

    it('ignores an old UP echo after a genuine wall STOP', async t => {
        const f = fixture(t);
        const up = f.move(80); await f.ack(0); await up;
        await f.tick(100);
        f.blind.onData('*2*0*2##'); // no STOP was sent: this is a wall command
        f.blind.onData('*2*1*2##'); // late echo of our UP
        await f.tick(1000);
        assert.equal(f.blind.snapshot().moving, 'stopped');
        approximately(f.blind.snapshot().position, 50.5);
        assert.equal(f.sent.length, 1);
    });

    it('does not let a STOP ACK overwrite a later manual restart', async t => {
        const f = fixture(t);
        const up = f.move(80); f.blind.onData('*2*1*2##'); await f.ack(0); await up;
        const stop = f.stop();
        f.blind.onData('*2*0*2##'); // current STOP echo
        f.blind.onData('*2*2*2##'); // subsequent wall DOWN
        await f.ack(1); await stop;
        assert.equal(f.blind.snapshot().moving, 'closing');
        assert.equal(f.blind.snapshot().blindPhase, 'moving');
        assert.equal(f.blind.snapshot().targetPosition, 0);
        await f.tick(1000);
        approximately(f.blind.snapshot().position, 45);
        assert.equal(f.sent.length, 2);
    });

    for (const waiting of ['queue', 'handshake'] as const) {
        it(`a wall reversal cancels an older STOP waiting in the ${waiting}`, async t => {
            const f = fixture(t, {}, undefined, waiting !== 'handshake');
            f.client.maxConcurrent = 1;
            const up = f.move(80);
            if (waiting === 'handshake') f.connections[0].emit('connected');
            f.blind.onData('*2*1*2##'); await f.ack(0); await up;
            if (waiting === 'queue') f.client.sendCommand({ command: 'blocker' });
            const stop = f.stop();
            const cancelled = assert.rejects(stop, (err: unknown) => err instanceof BlindError && err.code === 'cancelled');
            f.blind.onData('*2*2*2##');
            if (waiting === 'handshake') f.connections[1].emit('connected');
            else await f.ack(1);
            await cancelled;
            await f.tick(1000);
            assert.equal(f.sent.includes('*2*0*2##'), false);
            assert.equal(f.blind.snapshot().moving, 'closing');
            assert.equal(f.blind.snapshot().blindPhase, 'moving');
            assert.equal(f.blind.snapshot().targetPosition, 0);
            approximately(f.blind.snapshot().position, 45);
        });
    }

    it('retargets an ongoing movement without resetting its fractional estimate', async t => {
        const f = fixture(t);
        const first = f.move(80); await f.ack(0); await first;
        await f.tick(125);
        const second = f.move(90); await second;
        assert.equal(f.sent.length, 1);
        await f.tick(1000);
        assert.equal(f.blind.snapshot().position, 55.625);
        assert.equal(f.blind.snapshot().targetPosition, 90);
    });

    it('duplicate direction reports after the echo window do not discard an automatic target', async t => {
        const f = fixture(t);
        const move = f.move(80); await f.ack(0); await move;
        await f.tick(2000);
        f.blind.onData('*2*1*2##'); f.blind.onData('*2*1000#1*2##');
        assert.equal(f.blind.snapshot().targetPosition, 80);
        await f.tick(4000);
        assert.equal(f.sent[1], '*2*0*2##'); await f.ack(1);
        assert.equal(f.blind.snapshot().position, 80);
    });

    it('retargeting to the current position stops instead of reversing', async t => {
        const f = fixture(t);
        const move = f.move(80); await f.ack(0); await move;
        await f.tick(1000);
        const hold = f.move(f.blind.snapshot().position); await f.ack(1); await hold;
        await f.tick(1000);
        assert.deepEqual(f.sent, ['*2*1*2##', '*2*0*2##']);
    });

    it('handles many rapid targets without sending obsolete queued movements', async t => {
        const f = fixture(t); f.client.maxConcurrent = 1;
        f.client.sendCommand({ command: 'blocker' });
        const old = [f.move(80), f.move(20), f.move(90)];
        const latest = f.move(30);
        for (const promise of old) await assert.rejects(promise);
        await f.ack(0);
        assert.deepEqual(f.sent, ['blocker', '*2*2*2##']);
        await f.ack(1); await latest;
        assert.equal(f.blind.snapshot().targetPosition, 30);
    });

    it('a wall STOP wins even if an older status request is still outstanding', async t => {
        const f = fixture(t);
        f.blind.updateStatus();
        const accepted = f.move(80);
        f.blind.onData('*2*1*2##'); await f.ack(1); await accepted;
        await f.tick(1000);
        f.blind.onData('*2*0*2##');
        f.connections[0].onData('*2*1*2##'); // stale command-channel reply
        await f.ack(0); await f.tick(2000);
        assert.deepEqual(f.sent, ['*#2*2##', '*2*1*2##']);
        approximately(f.blind.snapshot().position, 55);
        approximately(f.blind.snapshot().targetPosition, 55);
        assert.equal(f.blind.snapshot().moving, 'stopped');
    });

    it('a rejected calibration keeps the old position and marks it uncertain', async t => {
        const f = fixture(t);
        const calibration = f.calibrate();
        assert.equal(f.blind.snapshot().position, 50);
        f.connections[0].onData(PKT.NACK);
        await assert.rejects(calibration);
        assert.equal(f.blind.serialize().position, 50);
        assert.equal(f.blind.serialize().confidence, 'unknown');
        await f.tick(30000);
        assert.equal(f.sent.length, 1);
    });

    it('times calibration from dispatch, includes slats, and commits only after final STOP', async t => {
        const f = fixture(t, { timeDown: 25, timeSlat: 2, slatPercent: 10 });
        f.client.maxConcurrent = 1;
        f.client.sendCommand({ command: '*#1*9##' });
        const calibration = f.calibrate();
        await f.tick(3000);
        assert.equal(f.blind.snapshot().position, 50);
        await f.ack(0); await f.ack(1); await calibration;
        await f.tick(27990);
        assert.equal(f.sent.length, 2);
        assert.notEqual(f.blind.serialize().confidence, 'calibrated');
        await f.tick(10);
        assert.equal(f.sent[2], '*2*0*2##');
        await f.ack(2);
        assert.equal(f.blind.serialize().confidence, 'calibrated');
        assert.equal(f.blind.serialize().wasMoving, false);
        assert.equal(f.blind.snapshot().calibrating, false);
    });

    it('an interrupted calibration never establishes a zero reference', async t => {
        const f = fixture(t);
        const calibration = f.calibrate(); await f.ack(0); await calibration;
        await f.tick(1000);
        f.blind.onData('*2*0*2##');
        assert.equal(f.blind.snapshot().position, 45);
        assert.equal(f.blind.snapshot().positionConfidence, 'unknown');
        await f.tick(30000);
        assert.equal(f.sent.length, 1);
    });

    it('accepts the specified natural end-stop at full travel before the safety margin expires', async t => {
        const f = fixture(t, {}, { blindPosition: 100 });
        const calibration = f.calibrate(); await f.ack(0); await calibration;
        await f.tick(20000);
        f.blind.onData('*2*0*2##');
        assert.equal(f.blind.snapshot().position, 0);
        assert.equal(f.blind.snapshot().positionConfidence, 'calibrated');
        assert.equal(f.blind.snapshot().calibrating, false);
        await f.tick(2000);
        assert.deepEqual(f.sent, ['*2*2*2##']);
    });

    it('uses DIM10 positions to correct travel and complete at the hardware target', async t => {
        const f = fixture(t);
        const move = f.move(80); await f.ack(0); await move;
        await f.tick(1000);
        f.blind.onData('*#2*2*10*11*60*0*0##');
        approximately(f.blind.snapshot().position, 60);
        assert.equal(f.blind.snapshot().targetPosition, 80);
        await f.tick(4000);
        assert.equal(f.sent[1], '*2*0*2##');
        f.blind.onData('*#2*2*10*10*80*0*0##'); await f.ack(1);
        assert.equal(f.blind.snapshot().positionConfidence, 'measured');
        assert.equal(f.blind.snapshot().position, 80);
        assert.equal(f.blind.snapshot().moving, 'stopped');
    });

    it('still awaits the command ACK if DIM10 reports the target first', async t => {
        const f = fixture(t);
        let completed = false;
        const move = f.move(80).then(() => { completed = true; });
        f.blind.onData('*#2*2*10*10*80*0*0##');
        await settle();
        assert.equal(completed, false);
        assert.equal(f.blind.snapshot().position, 80);
        await f.ack(0); await move;
        assert.equal(f.blind.snapshot().blindPhase, 'idle');
        assert.deepEqual(f.sent, ['*2*1*2##']);
    });

    it('does not treat unchanged DIM10 movement telemetry as a wall command during STOP', async t => {
        const f = fixture(t);
        const move = f.move(80); f.blind.onData('*2*1*2##'); await f.ack(0); await move;
        const stop = f.stop();
        f.blind.onData('*#2*2*10*11*55*0*0##');
        await f.ack(1); await stop;
        assert.equal(f.blind.snapshot().moving, 'stopped');
        approximately(f.blind.snapshot().position, 55);
    });

    it('does not turn a hardware unknown-position report into an invented timed reference', async t => {
        const f = fixture(t);
        f.blind.onData('*#2*2*10*10*255*0*0##');
        assert.equal(f.blind.snapshot().positionConfidence, 'unknown');
        const calibration = f.calibrate(); await f.ack(0); await calibration;
        await f.tick(21000); await f.ack(1);
        assert.equal(f.blind.snapshot().positionConfidence, 'unknown');
        f.blind.onData('*#2*2*10*10*0*0*0##');
        assert.equal(f.blind.snapshot().positionConfidence, 'measured');
    });

    it('respects an actuator disabled/rejected state and recovers on a normal report', async t => {
        const f = fixture(t);
        f.blind.onData('*#2*2*10*10*50*0*14##');
        assert.equal(f.blind.snapshot().blindPhase, 'fault');
        await assert.rejects(f.move(100));
        assert.equal(f.sent.length, 0);
        f.blind.onData('*#2*2*10*10*50*0*0##');
        const move = f.move(80); await f.ack(0); await move;
        assert.deepEqual(f.sent, ['*2*1*2##']);
    });

    it('supports a shutter on a local bus using its exact WHERE address', async t => {
        const f = fixture(t, { where: '68#4#01' });
        const move = f.move(80); await f.ack(0); await move;
        assert.equal(f.sent[0], '*2*1*68#4#01##');
        f.blind.onData('*#2*68#4#01*10*10*80*0*0##');
        assert.equal(f.blind.snapshot().position, 80);
    });

    it('rejects unknown partial positions but allows a full run to establish a reference', async t => {
        const f = fixture(t, {}, {});
        await assert.rejects(f.move(40), (e: unknown) => e instanceof BlindError && e.code === 'invalid');
        const full = f.move(100); await f.ack(0); await full;
        await f.tick(21000); await f.ack(1);
        assert.equal(f.blind.snapshot().position, 100);
        assert.equal(f.blind.snapshot().positionConfidence, 'calibrated');
    });

    it('does not snap a manual STOP near an endpoint to a false reference', async t => {
        const f = fixture(t, {}, { blindPosition: 5 });
        f.blind.onData('*2*2*2##'); await f.tick(400);
        f.blind.onData('*2*0*2##');
        assert.equal(f.blind.snapshot().position, 3);
        assert.equal(f.blind.snapshot().positionConfidence, 'estimated');
    });

    it('filters one F454 phantom but accepts the opposite direction and a later re-press', async t => {
        const f = fixture(t);
        f.blind.onData('*2*2*2##'); await f.tick(1000); f.blind.onData('*2*0*2##');
        f.blind.onData('*2*2*2##');
        assert.equal(f.blind.snapshot().moving, 'stopped');
        f.blind.onData('*2*1*2##');
        assert.equal(f.blind.snapshot().moving, 'opening');
        await f.tick(1000); f.blind.onData('*2*0*2##'); await f.tick(151);
        f.blind.onData('*2*1*2##');
        assert.equal(f.blind.snapshot().moving, 'opening');
    });

    it('a redundant STOP closes the phantom window so a same-direction re-press passes', async t => {
        const f = fixture(t);
        f.blind.onData('*2*2*2##'); await f.tick(1000);
        f.blind.onData('*2*0*2##'); f.blind.onData('*2*0*2##');
        f.blind.onData('*2*2*2##');
        assert.equal(f.blind.snapshot().moving, 'closing');
    });

    it('a missing manual end-stop echo eventually stops reporting movement without claiming calibration', async t => {
        const f = fixture(t);
        f.blind.onData('*2*1*2##'); await f.tick(21000);
        assert.equal(f.blind.snapshot().position, 100);
        assert.equal(f.blind.snapshot().moving, 'stopped');
        assert.equal(f.blind.snapshot().positionConfidence, 'estimated');
        assert.equal(f.sent.length, 0);
    });

    it('a STOP refusal leaves a fault rather than reporting success', async t => {
        const f = fixture(t);
        const move = f.move(80); await f.ack(0); await move;
        const stop = f.stop(); f.connections[1].onData(PKT.NACK);
        await assert.rejects(stop);
        assert.equal(f.blind.snapshot().blindPhase, 'fault');
        assert.equal(f.blind.serialize().confidence, 'unknown');
        assert.equal(f.blind.serialize().wasMoving, true);
    });

    it('ignores wrong addresses and unsupported packets and handles extended directions', async t => {
        const f = fixture(t);
        f.blind.onData('*2*1*9##'); f.blind.onData('*2*1000#7*2##');
        assert.equal(f.blind.snapshot().moving, 'stopped');
        f.blind.onData('*2*1000#1*2##'); await f.tick(1000);
        approximately(f.blind.snapshot().position, 55);
        f.blind.onData('*2*1000#0*2##');
        assert.equal(f.blind.snapshot().moving, 'stopped');
    });

    it('a disconnect invalidates the position, attempts STOP and never resumes the old target', async t => {
        const f = fixture(t);
        f.blind.updateStatus(); await f.ack(0);
        const move = f.move(80); await f.ack(1); await move;
        await f.tick(1000);
        f.blind.setOnline(false);
        assert.equal(f.sent[2], '*2*0*2##'); await f.ack(2);
        assert.equal(f.blind.snapshot().positionConfidence, 'unknown');
        f.blind.setOnline(true); f.blind.updateStatus();
        f.connections[3].onData('*2*0*2##'); await f.ack(3); await f.tick(30000);
        assert.deepEqual(f.sent, ['*#2*2##', '*2*1*2##', '*2*0*2##', '*#2*2##']);
    });

    it('saves a dirty movement marker and restores it as unknown after restart', async t => {
        const f = fixture(t);
        const move = f.move(80); await f.ack(0); await move;
        await f.tick(1000);
        const context = JSON.parse(JSON.stringify({ blindState: f.blind.serialize() }));
        const restored = new OwnBlindController(f.client, f.client.log, { id: 3, time: 20 }, context, () => {}, { now: () => Date.now() });
        approximately(restored.snapshot().position, 55);
        assert.equal(restored.snapshot().positionConfidence, 'unknown');
        restored.destroy();
        f.blind.onData('*2*0*2##');
        assert.ok(f.events.some(event => event.persist === 'now' && event.state.moving === 'stopped'));
    });

    it('supports whenUnknown calibration and preserves legacy calibrateOnStart:false', async t => {
        const f = fixture(t, { calibration: 'whenUnknown' });
        f.blind.updateStatus();
        assert.deepEqual(f.sent, ['*#2*2##']); await f.ack(0);
        const other = new OwnBlindController(f.client, f.client.log, { id: 3, time: 20, calibration: 'whenUnknown' }, {}, () => {}, { now: () => Date.now() });
        other.setOnline(true); other.updateStatus();
        assert.equal(f.sent[1], '*2*2*3##'); await f.ack(1);
        other.destroy();
    });

    it('identify uses a one-second dispatched jog rather than a full movement', async t => {
        const f = fixture(t);
        const identify = f.blind.identify(); await f.ack(0); await identify;
        await f.tick(1000);
        assert.equal(f.sent[1], '*2*0*2##'); await f.ack(1);
        approximately(f.blind.snapshot().position, 55);
    });

    for (const config of [{ time: NaN }, { time: Infinity }, { time: 0 }, { timeSlat: 2 }, { slatPercent: 100 }, { timeSlat: -1 }]) {
        it(`rejects inconsistent timing ${JSON.stringify(config)}`, t => {
            assert.throws(() => fixture(t, config));
        });
    }
});
