import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseScanArgs } from '../lib/scanArgs';

describe('parseScanArgs', () => {
    it('uses default port, password and range with only a host', () => {
        assert.deepEqual(parseScanArgs(['gateway.local']), {
            host: 'gateway.local', port: 20000, password: '', maxAddr: 20,
            verbose: false, invalidMaxAddr: false,
        });
    });

    it('does not use the range as a port when only a host is provided', () => {
        const args = parseScanArgs(['gateway.local', '--max-addr', '50']);
        assert.equal(args.port, 20000);
        assert.equal(args.password, '');
        assert.equal(args.maxAddr, 50);
    });

    it('does not use the range as a password when a port is provided', () => {
        const args = parseScanArgs(['gateway.local', '21000', '--max-addr', '50']);
        assert.equal(args.port, 21000);
        assert.equal(args.password, '');
        assert.equal(args.maxAddr, 50);
    });

    it('keeps an explicit password and accepts options in any position', () => {
        const expected = {
            host: 'gateway.local', port: 21000, password: '12345', maxAddr: 50,
            verbose: true, invalidMaxAddr: false,
        };
        for (const argv of [
            ['gateway.local', '21000', '12345', '--max-addr', '50', '--verbose'],
            ['--max-addr', '50', 'gateway.local', '--verbose', '21000', '12345'],
            ['--verbose', 'gateway.local', '21000', '--max-addr', '50', '12345'],
        ]) {
            assert.deepEqual(parseScanArgs(argv), expected);
        }
    });

    it('falls back to the default range for invalid values without altering connection arguments', () => {
        for (const value of ['0', '1000', '-1', 'invalid', '20x', '20.5', '1e2']) {
            const args = parseScanArgs(['gateway.local', '--max-addr', value]);
            assert.equal(args.maxAddr, 20);
            assert.equal(args.invalidMaxAddr, true);
            assert.equal(args.port, 20000);
            assert.equal(args.password, '');
        }
    });

    it('reports a missing range value without consuming the next option', () => {
        const args = parseScanArgs(['gateway.local', '--max-addr', '--verbose']);
        assert.equal(args.invalidMaxAddr, true);
        assert.equal(args.maxAddr, 20);
        assert.equal(args.verbose, true);
    });

    it('leaves a missing host empty so the CLI can display usage', () => {
        assert.equal(parseScanArgs(['--max-addr', '50']).host, '');
    });
});
