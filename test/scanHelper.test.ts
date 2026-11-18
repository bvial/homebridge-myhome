import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runStatusScan } from '../lib/scanHelper';
import { PKT } from '../lib/OwnNet';

describe('runStatusScan', () => {
    it('resolves even when sendCommand rejects every job (queue saturated)', async () => {
        const client = {
            sendCommand: () => false,
        };

        const result = await runStatusScan(client as never, 2);
        assert.deepEqual(result, []);
    });

    it('does not invent WHO=2 blinds from an ACK without a state reply', async () => {
        const client = {
            sendCommand: (params: { command: string; done?: (pkt: string | null) => void }) => {
                if (params.command.startsWith('*#2*') && params.done) {
                    params.done(PKT.ACK);
                    return true;
                }
                if (params.done) params.done(PKT.NACK);
                return true;
            },
        };

        const result = await runStatusScan(client as never, 1);
        const blinds = result.filter(x => x.who === 2 && x.where === '1');
        assert.equal(blinds.length, 0);
    });

    it('does not discover WHO=1 lights on ACK-only (requires data packet)', async () => {
        const client = {
            sendCommand: (params: { command: string; done?: (pkt: string | null) => void }) => {
                if (params.command.startsWith('*#1*') && params.done) {
                    params.done(PKT.ACK);
                    return true;
                }
                if (params.done) params.done(PKT.NACK);
                return true;
            },
        };

        const result = await runStatusScan(client as never, 1);
        const lights = result.filter(x => x.who === 1 && x.where === '1');
        assert.equal(lights.length, 0);
    });
});
