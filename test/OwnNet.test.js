'use strict';
var { describe, it, beforeEach } = require('node:test');
var assert = require('node:assert/strict');
var events = require('events');
var { OwnConnection, OwnClient, calcPass, MODE, PKT, CMD } = require('../lib/OwnNet.js');

describe('calcPass', function () {
    it('returns 0 for password 0 and nonce 0', function () {
        assert.equal(calcPass('0', '0'), '0');
    });

    it('computes known vector', function () {
        var result = calcPass('12345', '603356072');
        assert.equal(typeof result, 'string');
        assert.match(result, /^\d+$/);
    });

    it('exercises all nonce digits', function () {
        var result = calcPass('99999', '1234567890');
        assert.equal(typeof result, 'string');
        assert.match(result, /^\d+$/);
    });

    it('returns consistent results', function () {
        var a = calcPass('12345', '98765');
        var b = calcPass('12345', '98765');
        assert.equal(a, b);
    });

    it('different passwords produce different results', function () {
        var a = calcPass('11111', '12345');
        var b = calcPass('22222', '12345');
        assert.notEqual(a, b);
    });

    it('throws on non-numeric password', function () {
        assert.throws(() => calcPass('abc', '12345'), /must be a number/);
    });

    it('throws on undefined password', function () {
        assert.throws(() => calcPass(undefined, '12345'), /must be a number/);
    });
});

describe('OwnConnection state machine', function () {
    var conn, written, destroyed;

    beforeEach(function () {
        written = [];
        destroyed = false;
        conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: function () {}, debug: function () {}, warn: function () {}, error: function () {},
        });
        conn.conn = {
            write: function (d) { written.push(d); },
            end: function () {},
            destroy: function () { destroyed = true; },
            removeAllListeners: function () {},
            setTimeout: function () {},
            on: function () {},
        };
    });

    it('transitions UNCONNECTED -> CONNECTING on ACK (monitor)', function () {
        conn.state = 'UNCONNECTED';
        conn.onData(Buffer.from(PKT.ACK));
        assert.equal(conn.state, 'CONNECTING');
        assert.deepEqual(written, [CMD.START_MONITOR]);
    });

    it('sends COMMAND start for command mode', function () {
        conn.mode = MODE.COMMAND;
        conn.state = 'UNCONNECTED';
        conn.onData(Buffer.from(PKT.ACK));
        assert.equal(conn.state, 'CONNECTING');
        assert.deepEqual(written, [CMD.START_COMMAND]);
    });

    it('transitions CONNECTING -> CONNECTED on ACK', function () {
        conn.state = 'CONNECTING';
        var emitted = false;
        conn.on('connected', function () { emitted = true; });
        conn.onData(Buffer.from(PKT.ACK));
        assert.equal(conn.state, 'CONNECTED');
        assert.ok(emitted);
    });

    it('sends password on nonce in CONNECTING', function () {
        conn.state = 'CONNECTING';
        conn.onData(Buffer.from('*#603356072##'));
        assert.equal(conn.state, 'LOGGING_IN');
        assert.equal(written.length, 1);
        assert.match(written[0], /^\*#\d+##$/);
    });

    it('transitions LOGGING_IN -> CONNECTED on ACK', function () {
        conn.state = 'LOGGING_IN';
        var emitted = false;
        conn.on('connected', function () { emitted = true; });
        conn.onData(Buffer.from(PKT.ACK));
        assert.equal(conn.state, 'CONNECTED');
        assert.ok(emitted);
    });

    it('handles NACK in LOGGING_IN', function () {
        conn.state = 'LOGGING_IN';
        conn.onData(Buffer.from(PKT.NACK));
        assert.equal(conn.state, 'UNCONNECTED');
        assert.ok(destroyed);
    });

    it('emits auth-failed on NACK in LOGGING_IN', function () {
        conn.state = 'LOGGING_IN';
        var authFailed = false;
        conn.on('auth-failed', function () { authFailed = true; });
        conn.onData(Buffer.from(PKT.NACK));
        assert.ok(authFailed);
    });

    it('end() calls destroy and removes listeners', function () {
        var destroyed = false;
        var listenersRemoved = false;
        conn.conn = {
            write: function () {},
            end: function () {},
            destroy: function () { destroyed = true; },
            removeAllListeners: function () { listenersRemoved = true; },
            setTimeout: function () {},
            on: function () {},
        };
        conn.end();
        assert.ok(destroyed);
        assert.ok(listenersRemoved);
        assert.equal(conn.conn, null);
    });

    it('emits packet in CONNECTED state', function () {
        conn.state = 'CONNECTED';
        var packets = [];
        conn.on('packet', function (p) { packets.push(p); });
        conn.onData(Buffer.from('*1*1*42##'));
        assert.deepEqual(packets, ['*1*1*42##']);
    });
});

describe('TCP fragmentation', function () {
    var conn, packets;

    beforeEach(function () {
        packets = [];
        conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: function () {}, debug: function () {}, warn: function () {}, error: function () {},
        });
        conn.conn = { write: function () {}, end: function () {}, setTimeout: function () {}, on: function () {} };
        conn.state = 'CONNECTED';
        conn.on('packet', function (p) { packets.push(p); });
    });

    it('handles partial then rest', function () {
        conn.onData(Buffer.from('*1*1'));
        assert.equal(packets.length, 0);
        conn.onData(Buffer.from('*42##'));
        assert.deepEqual(packets, ['*1*1*42##']);
    });

    it('handles multiple packets in one data event', function () {
        conn.onData(Buffer.from('*1*1*42##*1*0*43##'));
        assert.deepEqual(packets, ['*1*1*42##', '*1*0*43##']);
    });

    it('handles three packets split across two events', function () {
        conn.onData(Buffer.from('*1*1*42##*1*0*43'));
        assert.deepEqual(packets, ['*1*1*42##']);
        conn.onData(Buffer.from('##*2*1*10##'));
        assert.deepEqual(packets, ['*1*1*42##', '*1*0*43##', '*2*1*10##']);
    });

    it('discards buffer when it overflows with no valid packet', function () {
        conn.onData(Buffer.from('x'.repeat(5000)));
        assert.equal(packets.length, 0);
        conn.onData(Buffer.from('*1*1*42##'));
        assert.deepEqual(packets, ['*1*1*42##']);
    });
});

describe('OwnClient command queue', function () {
    it('limits concurrent commands', function (t, done) {
        var client = new OwnClient('127.0.0.1', '20000', '12345', {
            info: function () {}, debug: function () {}, warn: function () {}, error: function () {},
        });
        client._maxConcurrent = 1;

        var order = [];
        var originalExecute = client._executeCommand.bind(client);

        client._executeCommand = function (params) {
            order.push(params.id);
            client._releaseSlot();
        };

        client.sendCommand({ id: 'A' });
        client.sendCommand({ id: 'B' });
        client.sendCommand({ id: 'C' });

        assert.deepEqual(order, ['A', 'B', 'C']);
        done();
    });

    it('drops commands when queue is full', function () {
        var warnings = [];
        var client = new OwnClient('127.0.0.1', '20000', '12345', {
            info: function () {}, debug: function () {}, warn: function () { warnings.push(true); }, error: function () {},
        });
        client._executeCommand = function () {};
        client._maxConcurrent = 0;
        for (var i = 0; i < 50; i++) {
            client.sendCommand({ command: '*1*1*' + i + '##' });
        }
        assert.equal(client._commandQueue.length, 50);
        client.sendCommand({ command: '*1*1*overflow##' });
        assert.equal(client._commandQueue.length, 50);
        assert.ok(warnings.length > 0);
    });
});

describe('OwnConnection logPacket masking', function () {
    it('masks packets during CONNECTING state', function () {
        var debugCalls = [];
        var conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: function () {}, debug: function () { debugCalls.push(Array.from(arguments)); }, warn: function () {}, error: function () {},
        });
        conn.state = 'CONNECTING';
        conn.logPacket('IN', '*#603356072##');
        assert.ok(debugCalls.length > 0);
        assert.ok(debugCalls[0].join(' ').includes('[auth]'));
        assert.ok(!debugCalls[0].join(' ').includes('603356072'));
    });

    it('masks packets during LOGGING_IN state', function () {
        var debugCalls = [];
        var conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: function () {}, debug: function () { debugCalls.push(Array.from(arguments)); }, warn: function () {}, error: function () {},
        });
        conn.state = 'LOGGING_IN';
        conn.logPacket('OUT', '*#987654##');
        assert.ok(debugCalls[0].join(' ').includes('[auth]'));
    });

    it('shows packets in CONNECTED state', function () {
        var debugCalls = [];
        var conn = new OwnConnection('127.0.0.1', '20000', '12345', MODE.MONITOR, {
            info: function () {}, debug: function () { debugCalls.push(Array.from(arguments)); }, warn: function () {}, error: function () {},
        });
        conn.state = 'CONNECTED';
        conn.logPacket('IN', '*1*1*42##');
        assert.ok(debugCalls[0].join(' ').includes('*1*1*42##'));
    });
});

describe('OwnClient command failure callback', function () {
    it('calls done with null and -1 on connection close without response', function (t, done) {
        var client = new OwnClient('127.0.0.1', '20000', '12345', {
            info: function () {}, debug: function () {}, warn: function () {}, error: function () {},
        });
        client._maxConcurrent = 1;

        var closeCb;
        client.newConnection = function () {
            var fakeConn = {
                _handlers: {},
                on: function (ev, cb) { this._handlers[ev] = cb; },
                emit: function (ev) { if (this._handlers[ev]) this._handlers[ev](); },
                connect: function () {},
                setTimeout: function () {},
                end: function () {},
            };
            closeCb = function () { fakeConn._handlers['close'](); };
            return fakeConn;
        };

        client.sendCommand({
            command: '*1*1*42##',
            done: function (pkt, index) {
                assert.equal(pkt, null);
                assert.equal(index, -1);
                done();
            },
        });

        closeCb();
    });
});
