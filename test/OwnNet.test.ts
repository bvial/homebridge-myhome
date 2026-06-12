import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OwnConnection, OwnClient, OwnMonitor, calcPass, MODE, PKT, CMD, STATE } from '../lib/OwnNet';
import type { CommandParams } from '../lib/OwnNet';

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
});

describe('OwnMonitor reconnect logic', () => {
    function makeMockClient() {
        const commands: CommandParams[] = [];
        return {
            log: { info: function () {}, debug: function () {}, warn: function () {}, error: function () {}, success: function () {} } as unknown as import('homebridge').Logging,
            sendCommand: function (params: CommandParams) { commands.push(params); },
            newConnection: function () { return null as unknown as OwnConnection; },
            commands: commands,
        };
    }

    it('nbCheck increments on each restartConnection call when < 3', () => {
        const client = makeMockClient();
        const monitor = new OwnMonitor(client as unknown as OwnClient);
        assert.equal(monitor.nbCheck, 0);
        monitor.restartConnection();
        assert.equal(monitor.nbCheck, 1);
        monitor.restartConnection();
        assert.equal(monitor.nbCheck, 2);
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
});
