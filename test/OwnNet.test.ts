import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { OwnConnection, OwnClient, OwnMonitor, calcPass, MODE, PKT, CMD, STATE } from '../lib/OwnNet';
import type { CommandParams } from '../lib/OwnNet';
import { COMMAND_TIMEOUT_MS } from '../lib/utils';
import { runStatusScan } from '../lib/scanHelper';

describe('calcPass', () => {
    it('returns 0 for password 0 and nonce 0', () => {
        assert.equal(calcPass('0', '0'), '0');
    });

    it('computes known vector', () => {
        assert.equal(calcPass('12345', '603356072'), '25280520');
    });

    it('throws on float password', () => {
        assert.throws(() => calcPass('12.9', '12345'), /decimal integer/);
    });

    it('exercises all nonce digits', () => {
        const result = calcPass('99999', '1234567890');
        assert.equal(typeof result, 'string');
        assert.match(result, /^\d+$/);
    });

    it('returns consistent results', () => {
        const a = calcPass('12345', '98765');
        const b = calcPass('12345', '98765');
        assert.equal(a, b);
    });

    it('different passwords produce different results', () => {
        const a = calcPass('11111', '12345');
        const b = calcPass('22222', '12345');
        assert.notEqual(a, b);
    });

    it('throws on non-numeric password', () => {
        assert.throws(() => calcPass('abc', '12345'), /decimal integer/);
    });

    it('throws on undefined password', () => {
        assert.throws(() => calcPass(undefined as unknown as string, '12345'), /decimal integer/);
    });

    it('throws on hex password (security: prevent silent miscompute)', () => {
        assert.throws(() => calcPass('0x1A', '12345'), /decimal integer/);
    });

    it('throws on empty password', () => {
        assert.throws(() => calcPass('', '12345'), /decimal integer/);
    });
});

describe('OwnConnection state machine', () => {
    let conn: OwnConnection;
    let written: string[];
    let destroyed: boolean;

    beforeEach(() => {
        written = [];
        destroyed = false;
        conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, success: () => {},
        } as unknown as import('homebridge').Logging);
        (conn as unknown as { conn: unknown }).conn = {
            write: (d: string) => { written.push(d); },
            end: () => {},
            destroy: () => { destroyed = true; },
            removeAllListeners: () => {},
            setTimeout: () => {},
            on: () => {},
        };
    });

    it('transitions UNCONNECTED -> CONNECTING on ACK (monitor)', () => {
        conn.state = 'UNCONNECTED';
        conn.onData(Buffer.from(PKT.ACK));
        assert.equal(conn.state, 'CONNECTING');
        assert.deepEqual(written, [CMD.START_MONITOR]);
    });

    it('sends COMMAND start for command mode', () => {
        conn.mode = MODE.COMMAND;
        conn.state = 'UNCONNECTED';
        conn.onData(Buffer.from(PKT.ACK));
        assert.equal(conn.state, 'CONNECTING');
        assert.deepEqual(written, [CMD.START_COMMAND]);
    });

    it('transitions CONNECTING -> CONNECTED on ACK', () => {
        conn.state = 'CONNECTING';
        let emitted = false;
        conn.on('connected', () => { emitted = true; });
        conn.onData(Buffer.from(PKT.ACK));
        assert.equal(conn.state, 'CONNECTED');
        assert.ok(emitted);
    });

    it('sends password on nonce in CONNECTING', () => {
        conn.state = 'CONNECTING';
        conn.onData(Buffer.from('*#603356072##'));
        assert.equal(conn.state, 'LOGGING_IN');
        assert.equal(written.length, 1);
        assert.match(written[0], /^\*#\d+##$/);
    });

    it('transitions LOGGING_IN -> CONNECTED on ACK', () => {
        conn.state = 'LOGGING_IN';
        let emitted = false;
        conn.on('connected', () => { emitted = true; });
        conn.onData(Buffer.from(PKT.ACK));
        assert.equal(conn.state, 'CONNECTED');
        assert.ok(emitted);
    });

    it('handles NACK in LOGGING_IN', () => {
        conn.state = 'LOGGING_IN';
        conn.onData(Buffer.from(PKT.NACK));
        assert.equal(conn.state, 'UNCONNECTED');
        assert.ok(destroyed);
    });

    it('emits auth-failed on NACK in LOGGING_IN', () => {
        conn.state = 'LOGGING_IN';
        let authFailed = false;
        conn.on('auth-failed', () => { authFailed = true; });
        conn.onData(Buffer.from(PKT.NACK));
        assert.ok(authFailed);
    });

    it('end() calls destroy and removes listeners', () => {
        let endDestroyed = false;
        let listenersRemoved = false;
        (conn as unknown as { conn: unknown }).conn = {
            write: () => {},
            end: () => {},
            destroy: () => { endDestroyed = true; },
            removeAllListeners: () => { listenersRemoved = true; },
            setTimeout: () => {},
            on: () => {},
        };
        conn.end();
        assert.ok(endDestroyed);
        assert.ok(listenersRemoved);
        assert.equal(conn.conn, null);
    });

    it('emits auth-failed and ends connection when password is non-numeric', () => {
        const events: string[] = [];
        conn.on('auth-failed', () => { events.push('auth-failed'); });
        conn.on('close', () => { events.push('close'); });
        conn.password = 'not-a-number';
        conn.state = 'CONNECTING';
        conn.onData(Buffer.from('*#603356072##'));
        assert.ok(events.includes('auth-failed'));
        assert.equal(conn.conn, null);
    });

    it('emits packet in CONNECTED state', () => {
        conn.state = 'CONNECTED';
        const packets: string[] = [];
        conn.on('packet', (p: string) => { packets.push(p); });
        conn.onData(Buffer.from('*1*1*42##'));
        assert.deepEqual(packets, ['*1*1*42##']);
    });
});

describe('TCP fragmentation', () => {
    let conn: OwnConnection;
    let packets: string[];

    beforeEach(() => {
        packets = [];
        conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, success: () => {},
        } as unknown as import('homebridge').Logging);
        (conn as unknown as { conn: unknown }).conn = { write: () => {}, end: () => {}, setTimeout: () => {}, on: () => {} };
        conn.state = 'CONNECTED';
        conn.on('packet', (p: string) => { packets.push(p); });
    });

    it('handles partial then rest', () => {
        conn.onData(Buffer.from('*1*1'));
        assert.equal(packets.length, 0);
        conn.onData(Buffer.from('*42##'));
        assert.deepEqual(packets, ['*1*1*42##']);
    });

    it('handles multiple packets in one data event', () => {
        conn.onData(Buffer.from('*1*1*42##*1*0*43##'));
        assert.deepEqual(packets, ['*1*1*42##', '*1*0*43##']);
    });

    it('handles three packets split across two events', () => {
        conn.onData(Buffer.from('*1*1*42##*1*0*43'));
        assert.deepEqual(packets, ['*1*1*42##']);
        conn.onData(Buffer.from('##*2*1*10##'));
        assert.deepEqual(packets, ['*1*1*42##', '*1*0*43##', '*2*1*10##']);
    });

    it('discards buffer when it overflows with no valid packet', () => {
        conn.onData(Buffer.from('x'.repeat(5000)));
        assert.equal(packets.length, 0);
        conn.onData(Buffer.from('*1*1*42##'));
        assert.deepEqual(packets, ['*1*1*42##']);
    });

    it('discards leading non-* junk characters and processes packet immediately', () => {
        conn.onData(Buffer.from('junk\r\n*1*1*42##'));
        assert.deepEqual(packets, ['*1*1*42##']);
    });
});

describe('OwnClient command queue', () => {
    it('limits concurrent commands', (_t: unknown, done: () => void) => {
        const client = new OwnClient('127.0.0.1', '20000', '12345', {
            info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, success: () => {},
        } as unknown as import('homebridge').Logging);
        client.maxConcurrent = 1;

        const order: (string | undefined)[] = [];
        (client as unknown as { executeCommand: (p: { id?: string }) => void }).executeCommand = function (params) {
            order.push(params.id);
            client.releaseSlot();
        };

        client.sendCommand({ command: '', id: 'A' });
        client.sendCommand({ command: '', id: 'B' });
        client.sendCommand({ command: '', id: 'C' });

        assert.deepEqual(order, ['A', 'B', 'C']);
        done();
    });

    it('drops commands when queue is full', () => {
        const warnings: boolean[] = [];
        const client = new OwnClient('127.0.0.1', '20000', '12345', {
            info: () => {}, debug: () => {}, warn: () => { warnings.push(true); }, error: () => {},
        } as unknown as import('homebridge').Logging);
        (client as unknown as { executeCommand: () => void }).executeCommand = function () {};
        client.maxConcurrent = 0;
        for (let i = 0; i < 50; i++) {
            client.sendCommand({ command: `*1*1*${i}##` });
        }
        assert.equal(client.commandQueue.length, 50);
        client.sendCommand({ command: '*1*1*overflow##' });
        assert.equal(client.commandQueue.length, 50);
        assert.ok(warnings.length > 0);
    });
});

describe('OwnConnection logPacket masking', () => {
    it('masks packets during CONNECTING state', () => {
        const debugCalls: unknown[][] = [];
        const conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: () => {}, debug: (...args: unknown[]) => { debugCalls.push(args); }, warn: () => {}, error: () => {},
        } as unknown as import('homebridge').Logging);
        conn.state = 'CONNECTING';
        conn.logPacket('IN', '*#603356072##');
        assert.ok(debugCalls.length > 0);
        assert.ok(debugCalls[0].join(' ').includes('[auth]'));
        assert.ok(!(debugCalls[0].join(' ').includes('603356072')));
    });

    it('masks packets during LOGGING_IN state', () => {
        const debugCalls: unknown[][] = [];
        const conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: () => {}, debug: (...args: unknown[]) => { debugCalls.push(args); }, warn: () => {}, error: () => {},
        } as unknown as import('homebridge').Logging);
        conn.state = 'LOGGING_IN';
        conn.logPacket('OUT', '*#987654##');
        assert.ok(debugCalls[0].join(' ').includes('[auth]'));
    });

    it('shows packets in CONNECTED state', () => {
        const debugCalls: unknown[][] = [];
        const conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: () => {}, debug: (...args: unknown[]) => { debugCalls.push(args); }, warn: () => {}, error: () => {},
        } as unknown as import('homebridge').Logging);
        conn.state = 'CONNECTED';
        conn.logPacket('IN', '*1*1*42##');
        assert.ok(debugCalls[0].join(' ').includes('*1*1*42##'));
    });
});

describe('OwnClient command failure callback', () => {
    it('calls done with null and -1 on connection close without response', (_t: unknown, done: () => void) => {
        const client = new OwnClient('127.0.0.1', '20000', '12345', {
            info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, success: () => {},
        } as unknown as import('homebridge').Logging);
        client.maxConcurrent = 1;

        let closeCb!: () => void;
        (client as unknown as { newConnection: () => unknown }).newConnection = () => {
            const fakeConn: { handlers: Record<string, () => void>; on: (ev: string, cb: () => void) => void; emit: (ev: string) => void; connect: () => void; setTimeout: () => void; end: () => void } = {
                handlers: {},
                on: (ev, cb) => { fakeConn.handlers[ev] = cb; },
                emit: (ev) => { if (fakeConn.handlers[ev]) fakeConn.handlers[ev](); },
                connect: () => {},
                setTimeout: () => {},
                end: () => {},
            };
            closeCb = () => { fakeConn.handlers['close'](); };
            return fakeConn;
        };

        client.sendCommand({
            command: '*1*1*42##',
            done: (pkt, index) => {
                assert.equal(pkt, null);
                assert.equal(index, -1);
                done();
            },
        });

        closeCb();
    });

    it('calls done with null and -1 and releases slot on auth-failed', (_t: unknown, done: () => void) => {
        const client = new OwnClient('127.0.0.1', '20000', '12345', {
            info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, success: () => {},
        } as unknown as import('homebridge').Logging);
        client.maxConcurrent = 1;

        let authFailedCb!: () => void;
        (client as unknown as { newConnection: () => unknown }).newConnection = () => {
            const fakeConn: { handlers: Record<string, () => void>; on: (ev: string, cb: () => void) => void; emit: (ev: string) => void; connect: () => void; setTimeout: () => void; end: () => void } = {
                handlers: {},
                on: (ev, cb) => { fakeConn.handlers[ev] = cb; },
                emit: (ev) => { if (fakeConn.handlers[ev]) fakeConn.handlers[ev](); },
                connect: () => {},
                setTimeout: () => {},
                end: () => {},
            };
            authFailedCb = () => { fakeConn.handlers['auth-failed']?.(); };
            return fakeConn;
        };

        client.sendCommand({
            command: '*1*1*42##',
            done: (pkt, index) => {
                assert.equal(pkt, null);
                assert.equal(index, -1);
                assert.equal(client.activeCommands, 0);
                done();
            },
        });

        assert.equal(client.activeCommands, 1);
        authFailedCb();
    });
});

describe('OwnClient command lifecycle', () => {
    function makeClient(connectImmediately = true) {
        const client = new OwnClient('127.0.0.1', 20000, '12345', {
            info: () => {}, debug: () => {}, warn: () => {}, error: () => {},
        } as unknown as import('homebridge').Logging);
        client.maxConcurrent = 1;
        const connections: OwnConnection[] = [];
        const sent: string[] = [];
        client.newConnection = (mode, log) => {
            const conn = new OwnConnection(client.host, client.port, client.password, mode, log ?? client.log);
            // Skip TCP I/O, but exercise OwnConnection's real parser and synchronous
            // end()/close behavior with an actual (unconnected) Node socket.
            conn.connect = () => {
                conn.conn = new Socket();
                if (connectImmediately) {
                    conn.state = STATE.CONNECTED;
                    conn.emit('connected');
                }
            };
            conn.sendPacket = packet => { sent.push(packet); };
            connections.push(conn);
            return conn;
        };
        return { client, connections, sent };
    }

    it('finishes ACK exactly once before synchronous close and advances one queued command', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { client, connections, sent } = makeClient();
        t.after(() => connections.forEach(conn => conn.end()));
        const results: Array<[string | null, number]> = [];
        client.sendCommand({ command: '*1*1*42##', done: (pkt, index) => results.push([pkt, index]) });
        client.sendCommand({ command: '*2*0*23##' });
        assert.equal(connections.length, 1);

        connections[0].onData(PKT.ACK);
        assert.deepEqual(results, [[PKT.ACK, 0]]);
        assert.equal(connections[0].conn, null);
        assert.deepEqual(sent, ['*1*1*42##', '*2*0*23##']);
        assert.equal(client.activeCommands, 1);
        assert.equal(client.queueSize(), 0);

        connections[0].emit('close');
        connections[0].emit('packet', PKT.ACK);
        assert.deepEqual(results, [[PKT.ACK, 0]]);
        assert.equal(client.activeCommands, 1, 'late events must not release the next command');
        connections[1].onData(PKT.ACK);
        t.mock.timers.tick(COMMAND_TIMEOUT_MS);
        assert.equal(client.activeCommands, 0);
        assert.deepEqual(results, [[PKT.ACK, 0]]);
    });

    it('detectGatewayModel reports only the successful model after closing its connection', t => {
        const { client, connections } = makeClient();
        t.after(() => connections.forEach(conn => conn.end()));
        const models: Array<string | null> = [];
        client.detectGatewayModel(model => models.push(model));
        connections[0].onData('*#13**15*200##' + PKT.ACK);
        assert.deepEqual(models, ['200']);
        assert.equal(client.activeCommands, 0);
    });

    it('serializes one device while allowing independent devices to use spare slots', t => {
        const { client, connections, sent } = makeClient();
        client.maxConcurrent = 2;
        t.after(() => client.destroy());
        client.sendCommand({ command: '*2*1*2##', serialKey: 'blind-2' });
        client.sendCommand({ command: '*2*0*2##', serialKey: 'blind-2' });
        client.sendCommand({ command: '*1*1*1##', serialKey: 'light-1' });
        assert.deepEqual(sent, ['*2*1*2##', '*1*1*1##']);
        connections[0].onData(PKT.NACK);
        assert.deepEqual(sent, ['*2*1*2##', '*1*1*1##', '*2*0*2##']);
        assert.equal(client.activeCommands, 2);
        connections[1].onData(PKT.ACK);
        connections[2].onData(PKT.ACK);
        assert.equal(client.activeCommands, 0);
    });

    it('reports timeout distinctly and releases the device key for subsequent work', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { client, connections, sent } = makeClient();
        t.after(() => client.destroy());
        let failure: string | undefined;
        client.sendCommand({ command: '*2*1*2##', serialKey: 'blind-2', done: (_pkt, _index, reason) => { failure = reason; } });
        client.sendCommand({ command: '*2*0*2##', serialKey: 'blind-2' });
        t.mock.timers.tick(COMMAND_TIMEOUT_MS);
        assert.equal(failure, 'timeout');
        assert.deepEqual(sent, ['*2*1*2##', '*2*0*2##']);
        connections[1].onData(PKT.ACK);
        assert.equal(client.activeCommands, 0);
    });

    it('admits a STOP into the reserved capacity and dispatches it before unrelated work', t => {
        const { client, connections, sent } = makeClient();
        t.after(() => client.destroy());
        client.sendCommand({ command: 'active' });
        for (let i = 0; i < 50; i++) assert.equal(client.sendCommand({ command: `read-${i}`, priority: 'background' }), true);
        assert.equal(client.sendCommand({ command: 'overflow' }), false);
        assert.equal(client.sendCommand({ command: '*2*0*2##', priority: 'stop', serialKey: 'blind-2' }), true);
        connections[0].onData(PKT.ACK);
        assert.deepEqual(sent, ['active', '*2*0*2##']);
    });

    it('does not reorder a STOP ahead of earlier commands for the same key', t => {
        const { client, connections, sent } = makeClient();
        t.after(() => client.destroy());
        client.sendCommand({ command: 'active' });
        client.sendCommand({ command: 'up', serialKey: 'blind-2' });
        client.sendCommand({ command: 'stop', serialKey: 'blind-2', priority: 'stop' });
        connections[0].onData(PKT.ACK);
        assert.deepEqual(sent, ['active', 'up']);
        connections[1].onData(PKT.ACK);
        assert.deepEqual(sent, ['active', 'up', 'stop']);
    });

    it('cancels queued device commands exactly once without cancelling a written command', t => {
        const { client, connections, sent } = makeClient();
        t.after(() => client.destroy());
        const failures: string[] = [];
        client.sendCommand({ command: 'written', serialKey: 'blind-2' });
        for (const command of ['up', 'down']) client.sendCommand({ command, serialKey: 'blind-2', done: (_p, _i, reason) => { failures.push(reason!); } });
        client.cancelQueued('blind-2'); client.cancelQueued('blind-2');
        assert.deepEqual(failures, ['cancelled', 'cancelled']);
        assert.equal(client.activeCommands, 1);
        client.sendCommand({ command: 'stop', serialKey: 'blind-2', priority: 'stop' });
        connections[0].onData(PKT.ACK);
        assert.deepEqual(sent, ['written', 'stop']);
    });

    it('rechecks cancellation after a delayed handshake, before sending the packet', t => {
        const { client, connections, sent } = makeClient(false);
        t.after(() => client.destroy());
        let allowed = true;
        let reason: string | undefined;
        client.sendCommand({ command: 'up', shouldSend: () => allowed, done: (_p, _i, failure) => { reason = failure; } });
        allowed = false;
        connections[0].emit('connected');
        assert.equal(reason, 'cancelled');
        assert.deepEqual(sent, []);
        assert.equal(client.activeCommands, 0);
    });

    it('an abort removes queued work immediately and settles it only once', t => {
        const { client, connections, sent } = makeClient();
        t.after(() => client.destroy());
        const abort = new AbortController();
        const results: unknown[] = [];
        client.sendCommand({ command: 'blocker' });
        client.sendCommand({ command: 'dimming', signal: abort.signal, done: (packet, index, reason) => results.push([packet, index, reason]) });
        client.sendCommand({ command: 'next' });
        abort.abort(); abort.abort();
        assert.equal(client.queueSize(), 1);
        assert.deepEqual(results, [[null, -1, 'cancelled']]);
        connections[0].onData(PKT.ACK);
        assert.deepEqual(sent, ['blocker', 'next']);
        connections[1].onData(PKT.ACK);
        assert.equal(results.length, 1);
    });

    it('an abort closes an unfinished handshake and prevents a late write', t => {
        const { client, connections, sent } = makeClient(false);
        t.after(() => client.destroy());
        const abort = new AbortController();
        const results: unknown[] = [];
        client.sendCommand({ command: 'dimming', signal: abort.signal, done: (packet, index, reason) => results.push([packet, index, reason]) });
        abort.abort();
        connections[0].emit('connected');
        connections[0].emit('close');
        assert.deepEqual(sent, []);
        assert.deepEqual(results, [[null, -1, 'cancelled']]);
        assert.equal(client.activeCommands, 0);
        assert.equal(connections[0].conn, null);
    });

    it('an abort after writing still waits for the actual gateway result', t => {
        const { client, connections, sent } = makeClient();
        t.after(() => client.destroy());
        const abort = new AbortController();
        const results: unknown[] = [];
        client.sendCommand({ command: 'already-written', signal: abort.signal, done: (packet, index) => results.push([packet, index]) });
        abort.abort();
        assert.deepEqual(sent, ['already-written']);
        assert.deepEqual(results, []);
        assert.equal(client.activeCommands, 1);
        connections[0].onData(PKT.ACK);
        assert.deepEqual(results, [[PKT.ACK, 0]]);
    });

    it('handles cancellation inside the started callback before writing', t => {
        const { client, sent } = makeClient();
        t.after(() => client.destroy());
        const abort = new AbortController();
        let failure: string | undefined;
        client.sendCommand({ command: 'cancel-before-write', signal: abort.signal, started: () => abort.abort(), done: (_p, _i, reason) => { failure = reason; } });
        assert.deepEqual(sent, []);
        assert.equal(failure, 'cancelled');
        assert.equal(client.activeCommands, 0);
    });

    it('expires stale movements while other commands still occupy the queue', t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
        const { client, connections, sent } = makeClient();
        t.after(() => client.destroy());
        let reason: string | undefined;
        client.sendCommand({ command: 'active' });
        client.sendCommand({ command: 'stale-up', expiresAt: Date.now() + 5000, done: (_p, _i, failure) => { reason = failure; } });
        t.mock.timers.tick(5000);
        assert.equal(reason, 'expired');
        assert.equal(client.queueSize(), 0);
        connections[0].onData(PKT.ACK);
        assert.deepEqual(sent, ['active']);
    });

    for (const failure of ['close', 'auth-failed'] as const) {
        it(`finishes ${failure} exactly once when teardown also emits close`, t => {
            const { client, connections } = makeClient();
            t.after(() => connections.forEach(conn => conn.end()));
            const results: Array<[string | null, number]> = [];
            client.sendCommand({ command: '*1*1*42##', done: (pkt, index) => results.push([pkt, index]) });
            if (failure === 'close') connections[0].end();
            else {
                connections[0].state = STATE.LOGGING_IN;
                connections[0].onData(PKT.NACK);
            }
            connections[0].emit('close');
            assert.deepEqual(results, [[null, -1]]);
            assert.equal(connections[0].conn, null);
            assert.equal(client.activeCommands, 0);
        });
    }

    it('times out an unfinished handshake exactly once and ignores a late connected event', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { client, connections, sent } = makeClient(false);
        t.after(() => connections.forEach(conn => conn.end()));
        const results: Array<[string | null, number]> = [];
        client.sendCommand({ command: '*1*1*42##', done: (pkt, index) => results.push([pkt, index]) });
        t.mock.timers.tick(COMMAND_TIMEOUT_MS);
        connections[0].emit('connected');
        connections[0].emit('close');
        assert.deepEqual(results, [[null, -1]]);
        assert.deepEqual(sent, []);
        assert.equal(connections[0].conn, null);
        assert.equal(client.activeCommands, 0);
    });

    it('releases the slot and reports synchronous connection setup failure once', () => {
        const { client } = makeClient();
        client.newConnection = () => { throw new Error('connection setup failed'); };
        const results: Array<[string | null, number]> = [];
        client.sendCommand({ command: '*1*1*42##', done: (pkt, index) => results.push([pkt, index]) });
        assert.deepEqual(results, [[null, -1]]);
        assert.equal(client.activeCommands, 0);
    });

    for (const stopon of [undefined, PKT.ACK]) {
        it(`treats NACK as failure with stopon=${stopon ?? 'default'} and immediately sends queued STOP`, t => {
            const { client, connections, sent } = makeClient();
            t.after(() => connections.forEach(conn => conn.end()));
            const results: Array<[string | null, number]> = [];
            const packets: string[] = [];
            client.sendCommand({
                command: '*1*1*42##', stopon,
                done: (pkt, index) => results.push([pkt, index]),
                packet: pkt => packets.push(pkt),
            });
            client.sendCommand({ command: '*2*0*23##' });
            connections[0].onData(PKT.NACK);
            assert.deepEqual(results, [[null, -1]]);
            assert.deepEqual(packets, [], 'NACK is not a data packet');
            assert.deepEqual(sent, ['*1*1*42##', '*2*0*23##']);
            assert.equal(client.activeCommands, 1);
            assert.equal(client.queueSize(), 0);
            connections[1].onData(PKT.ACK);
            assert.equal(client.activeCommands, 0);
        });
    }

    it('preserves explicit NACK stop-condition packet and index without forwarding it as data', t => {
        const { client, connections } = makeClient();
        t.after(() => connections.forEach(conn => conn.end()));
        const results: Array<[string | null, number]> = [];
        const packets: string[] = [];
        client.sendCommand({
            command: '*#1*42##', stopon: [PKT.ACK, PKT.NACK],
            done: (pkt, index) => results.push([pkt, index]),
            packet: pkt => packets.push(pkt),
        });
        connections[0].onData(PKT.NACK);
        assert.deepEqual(results, [[PKT.NACK, 1]]);
        assert.deepEqual(packets, []);
        assert.equal(client.activeCommands, 0);
    });

    it('destroy closes monitor and command sockets, settles accepted work once, and rejects later work', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { client, connections, sent } = makeClient();
        client.maxConcurrent = 2;
        t.after(() => client.destroy());
        client.startMonitor();
        const results: Array<[number, string | null, number]> = [];
        for (let id = 1; id <= 4; id++) {
            assert.equal(client.sendCommand({
                command: `*1*1*${id}##`,
                done: (packet, index) => {
                    results.push([id, packet, index]);
                    assert.equal(client.sendCommand({ command: '*1*0*99##' }), false);
                },
            }), true);
        }
        assert.equal(client.queueSize(), 2);
        const sockets = connections.map(connection => connection.conn!);
        client.destroy();
        client.destroy();
        assert.equal(client.monitor, null);
        assert.equal(client.activeCommands, 0);
        assert.equal(client.queueSize(), 0);
        assert.ok(sockets.every(socket => socket.destroyed));
        assert.ok(connections.every(connection => connection.conn === null));
        assert.deepEqual(results.sort((a, b) => a[0] - b[0]), [
            [1, null, -1], [2, null, -1], [3, null, -1], [4, null, -1],
        ]);
        client.startMonitor();
        for (const connection of connections) {
            connection.emit('connected');
            connection.emit('packet', PKT.ACK);
            connection.emit('close');
        }
        t.mock.timers.tick(300_000);
        assert.deepEqual(sent, ['*1*1*1##', '*1*1*2##']);
        assert.equal(connections.length, 3);
        assert.equal(results.length, 4);
    });

    it('destroy continues cleanup when queued and active callbacks throw', () => {
        const { client, connections } = makeClient();
        let settled = 0;
        for (let id = 1; id <= 3; id++) {
            client.sendCommand({
                command: `*1*1*${id}##`,
                done: () => { settled++; throw new Error('callback failed'); },
            });
        }
        assert.doesNotThrow(() => client.destroy());
        assert.equal(settled, 3);
        assert.equal(client.activeCommands, 0);
        assert.equal(client.queueSize(), 0);
        assert.equal(connections[0].conn, null);
    });

    it('destroy resolves a scan in progress without opening sockets for later batches', async () => {
        const { client, connections } = makeClient();
        const scanning = runStatusScan(client, 30);
        assert.equal(connections.length, 1);
        assert.ok(client.queueSize() > 0);
        client.destroy();
        assert.deepEqual(await scanning, []);
        assert.equal(client.queueSize(), 0);
        assert.equal(client.activeCommands, 0);
        assert.equal(connections.length, 1);
    });

    it('stopMonitor remains restartable without discarding client listeners', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { client, connections } = makeClient();
        t.after(() => client.destroy());
        let starts = 0;
        client.on('monitoring', () => { starts++; });
        client.startMonitor();
        client.stopMonitor();
        client.startMonitor();
        assert.equal(starts, 2);
        assert.equal(connections.length, 2);
        assert.equal(connections[0].conn, null);
        assert.ok(connections[1].conn);
    });
});

describe('OwnMonitor reconnect logic', () => {
    function makeMockClient() {
        const commands: CommandParams[] = [];
        return {
            log: { info: function () {}, debug: function () {}, warn: function () {}, error: function () {}, success: function () {} } as unknown as import('homebridge').Logging,
            sendCommand: function (params: CommandParams) { commands.push(params); return true; },
            newConnection: function () { return null as unknown as OwnConnection; },
            commands: commands,
        };
    }

    it('nbCheck increments on each restartConnection call when < 3 (probe resolved between ticks)', () => {
        const client = makeMockClient();
        const monitor = new OwnMonitor(client as unknown as OwnClient);
        assert.equal(monitor.nbCheck, 0);
        // Each tick dispatches a probe and increments; resolve it (failure) so the next tick
        // is not skipped as "still in flight". Failure keeps nbCheck as-is (does not reset).
        monitor.restartConnection();
        assert.equal(monitor.nbCheck, 1);
        client.commands[client.commands.length - 1].done!(null, -1);
        monitor.restartConnection();
        assert.equal(monitor.nbCheck, 2);
        client.commands[client.commands.length - 1].done!(null, -1);
        clearTimeout(monitor.checkTimeout);
        clearTimeout(monitor.reconnectTimeout);
    });

    it('schedules reconnect when nbCheck reaches 3', () => {
        const client = makeMockClient();
        const monitor = new OwnMonitor(client as unknown as OwnClient);
        monitor.nbCheck = 3;
        monitor.restartConnection();
        assert.notEqual(monitor.reconnectTimeout, undefined);
        assert.equal(monitor.checkTimeout, undefined);
        clearTimeout(monitor.reconnectTimeout);
    });

    it('does not reconnect when authFailed is set', () => {
        const client = makeMockClient();
        const monitor = new OwnMonitor(client as unknown as OwnClient);
        monitor.authFailed = true;
        monitor.nbCheck = 3;
        monitor.restartConnection();
        assert.equal(monitor.reconnectTimeout, undefined);
    });

    it('checkMonitor done callback resets nbCheck on ACK when monitor is connected', () => {
        const client = makeMockClient();
        const monitor = new OwnMonitor(client as unknown as OwnClient);
        monitor.connection = { state: STATE.CONNECTED } as unknown as OwnConnection;
        monitor.nbCheck = 2;
        monitor.restartConnection();
        assert.equal(monitor.nbCheck, 3);
        const captured = client.commands[client.commands.length - 1];
        captured.done!('*#*1##', 0);
        assert.equal(monitor.nbCheck, 0);
        clearTimeout(monitor.checkTimeout);
        clearTimeout(monitor.reconnectTimeout);
    });

    it('checkMonitor done callback triggers reconnect when keep-alive OK but monitor not connected', () => {
        let connectCalled = false;
        const fakeConn = { on: () => {}, connect: () => {}, end: () => {}, removeAllListeners: () => {} };
        const client = makeMockClient();
        (client as unknown as { newConnection: () => OwnConnection }).newConnection = () => {
            connectCalled = true;
            return fakeConn as unknown as OwnConnection;
        };
        const monitor = new OwnMonitor(client as unknown as OwnClient);
        monitor.connection = null;
        monitor.nbCheck = 1;
        monitor.restartConnection();
        const captured = client.commands[client.commands.length - 1];
        captured.done!('*#*1##', 0);
        assert.ok(connectCalled, 'connect() should be called when monitor is disconnected');
        clearTimeout(monitor.checkTimeout);
        clearTimeout(monitor.reconnectTimeout);
    });

    it('checkMonitor done callback does not reset nbCheck on failure', () => {
        const client = makeMockClient();
        const monitor = new OwnMonitor(client as unknown as OwnClient);
        monitor.nbCheck = 2;
        monitor.restartConnection();
        assert.equal(monitor.nbCheck, 3);
        const captured = client.commands[client.commands.length - 1];
        captured.done!(null, -1);
        assert.equal(monitor.nbCheck, 3);
        clearTimeout(monitor.checkTimeout);
        clearTimeout(monitor.reconnectTimeout);
    });

    it('a dropped keep-alive probe (queue full) resets checkInFlight so probes are not deadlocked', () => {
        const client = makeMockClient();
        // Simulate a full command queue: sendCommand drops the probe and returns false.
        client.sendCommand = function () { return false; };
        const monitor = new OwnMonitor(client as unknown as OwnClient);
        monitor.checkMonitor();
        assert.equal(monitor.checkInFlight, false,
            'checkInFlight must be reset when the probe is not queued, else all future probes are skipped');
        clearTimeout(monitor.checkTimeout);
        clearTimeout(monitor.reconnectTimeout);
    });

    it('a skipped tick (previous probe still in flight) does not count toward the dead-connection threshold', () => {
        const client = makeMockClient();
        // sendCommand enqueues but never resolves `done`, so the probe stays in flight.
        const monitor = new OwnMonitor(client as unknown as OwnClient);
        monitor.nbCheck = 0;
        monitor.restartConnection();      // dispatches a probe (in flight), nbCheck → 1
        assert.equal(monitor.nbCheck, 1);
        monitor.restartConnection();      // probe still in flight → tick skipped, nbCheck stays 1
        assert.equal(monitor.nbCheck, 1,
            'a skipped in-flight tick must not advance nbCheck toward a spurious reconnect');
        clearTimeout(monitor.checkTimeout);
        clearTimeout(monitor.reconnectTimeout);
    });

    it('stopMonitor invalidates pending probes and prevents later connections, probes, or timers', t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const mockClient = makeMockClient();
        const client = new OwnClient('127.0.0.1', 20000, '12345', mockClient.log);
        client.sendCommand = mockClient.sendCommand;
        const connections: OwnConnection[] = [];
        client.newConnection = mode => {
            const connection = new OwnConnection(client.host, client.port, client.password, mode, client.log);
            connection.connect = () => {
                connection.conn = new Socket();
                connection.state = STATE.CONNECTED;
                connection.emit('connected');
            };
            connections.push(connection);
            return connection;
        };
        client.startMonitor();
        const monitor = client.monitor!;
        t.after(() => { client.stopMonitor(); monitor.stop(); });
        assert.equal(monitor.checkMonitor(), true);
        const probe = mockClient.commands[0];

        client.stopMonitor();
        probe.done!(PKT.ACK, 0);
        probe.done!(null, -1);
        assert.equal(connections.length, 1, 'a late probe must not recreate the connection');
        assert.equal(connections[0].conn, null);
        assert.equal(client.monitor, null);
        assert.equal(monitor.connection, null);
        assert.equal(monitor.checkInFlight, false);
        assert.equal(monitor.checkTimeout, undefined);
        assert.equal(monitor.reconnectTimeout, undefined);

        monitor.connect();
        monitor.restartConnection();
        monitor.resetAutoConnectTimeout();
        assert.equal(monitor.checkMonitor(), false);
        t.mock.timers.tick(300_000);
        assert.equal(connections.length, 1);
        assert.equal(mockClient.commands.length, 1);
        assert.equal(monitor.checkTimeout, undefined);
        assert.equal(monitor.reconnectTimeout, undefined);
    });
});
