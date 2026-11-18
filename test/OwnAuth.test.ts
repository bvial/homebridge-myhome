import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { createOwnHmacResponse, encodeOwnHash, decodeOwnHash } from '../lib/OwnAuth';
import { OwnConnection, MODE, PKT, STATE } from '../lib/OwnNet';
import { makeMockPlatform, makeMockClient } from './helpers';

describe('Legrand HMAC v1.1', () => {
    it('encodes each hexadecimal nibble as two decimal digits', () => {
        assert.equal(encodeOwnHash('af0001ff'), '1015000000011515');
        assert.equal(decodeOwnHash('1015000000011515', 4), 'af0001ff');
        assert.throws(() => decodeOwnHash('1699', 1));
        assert.throws(() => decodeOwnHash('000', 1));
    });

    for (const [algorithm, bytes, clientProof, serverProof] of [
        ['sha1', 20, '57174fde247f0bea7657ad3eee1f72fcf49c6ae4', 'f09232dbfa2e05660634f1921aa4107d58406bb8'],
        ['sha256', 32, '2601be5ebd55caa364d54cc8777e0998b87a28b767107432c9c4274353b1075e', 'c5ad663a2d6fe6aa3cf89cb1880b0e9e1854df82fab0d3a216075ef7f39dad85'],
    ] as const) {
        it(`${algorithm} matches independent hashlib vectors`, () => {
            const response = createOwnHmacResponse('MyHome123', '0000'.repeat(bytes), algorithm, Buffer.alloc(bytes, 0x11));
            assert.equal(response.packet, `*#${'0101'.repeat(bytes)}*${encodeOwnHash(clientProof)}##`);
            assert.equal(response.serverProof, encodeOwnHash(serverProof));
        });

        for (const valid of [true, false]) {
            it(`${algorithm} ${valid ? 'opens only after mutual authentication' : 'rejects an invalid server proof'}`, t => {
                const connection = new OwnConnection('unused', 20000, 'MyHome123', MODE.COMMAND, makeMockPlatform().log);
                connection.conn = new Socket();
                const sent: string[] = [];
                connection.sendPacket = packet => { sent.push(packet); };
                let connected = 0;
                let failed = 0;
                connection.on('connected', () => { connected++; assert.equal(connection.state, STATE.CONNECTED); });
                connection.on('auth-failed', () => { failed++; });
                t.after(() => connection.end());
                connection.onData(PKT.ACK);
                assert.equal(sent[0], '*99*9##');
                connection.onData(algorithm === 'sha1' ? '*98*1##' : '*98*2##');
                assert.equal(sent[1], PKT.ACK);
                const ra = '00'.repeat(bytes);
                connection.onData(`*#${encodeOwnHash(ra)}##`);
                assert.equal(connected, 0);
                const response = sent[2].match(/^\*#(\d+)\*(\d+)##$/)!;
                const rb = decodeOwnHash(response[1], bytes);
                const hash = (text: string) => createHash(algorithm).update(text).digest('hex');
                const key = hash('MyHome123');
                assert.equal(response[2], encodeOwnHash(hash(ra + rb + '736F70653E' + '636F70653E' + key)));
                connection.onData(`*#${valid ? encodeOwnHash(hash(ra + rb + key)) : '0000'.repeat(bytes)}##`);
                assert.equal(connected, valid ? 1 : 0);
                assert.equal(failed, valid ? 0 : 1);
                assert.equal(sent[3], valid ? PKT.ACK : PKT.NACK);
            });
        }
    }

    it('does not continue parsing a closed connection after the connected callback', () => {
        const connection = new OwnConnection('unused', 20000, '', MODE.COMMAND, makeMockPlatform().log);
        connection.conn = new Socket();
        connection.sendPacket = () => {};
        let connections = 0;
        connection.on('connected', () => { connections++; connection.end(); });
        connection.onData(PKT.ACK + PKT.ACK + PKT.ACK + PKT.ACK);
        assert.equal(connections, 1);
        assert.equal(connection.state, STATE.UNCONNECTED);
    });

    it('blocks command scans and monitoring after authentication fails', t => {
        const { client, connections } = makeMockClient(makeMockPlatform().log, false);
        client.maxConcurrent = 1;
        t.after(() => client.destroy());
        const completed: Array<string | null> = [];
        const queued = new AbortController();
        let failures = 0;
        client.on('auth-failed', () => { failures++; });
        client.sendCommand({ command: '*#13**15##', done: packet => completed.push(packet) });
        client.sendCommand({ command: '*#1*11##', signal: queued.signal, done: packet => completed.push(packet) });
        connections[0].state = STATE.LOGGING_IN;
        connections[0].onData(PKT.NACK);
        assert.equal(failures, 1);
        assert.deepEqual(completed, [null, null]);
        assert.equal(client.activeCommands, 0);
        assert.equal(client.queueSize(), 0);
        assert.equal(client.sendCommand({ command: '*#1*12##' }), false);
        client.startMonitor();
        queued.abort();
        assert.equal(connections.length, 1);
        assert.equal(completed.length, 2);
    });
});
