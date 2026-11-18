/**
 * scan.ts — Discover MyHome devices and generate a Homebridge config draft.
 *
 * Usage:
 *   node dist/scan.js <host> [port] [password] [--max-addr N] [--verbose]
 *
 * Options:
 *   --max-addr N   Scan addresses 1..N per WHO type (default: 20)
 *   --verbose      Also show raw CONFIG-scan packets
 */

import { OwnClient, OwnConnection, PKT, CMD, MODE } from './lib/OwnNet';
import { errorMessage } from './lib/utils';
import { runStatusScan, ScanFound } from './lib/scanHelper';
import { parseScanArgs } from './lib/scanArgs';
import type { Logging } from 'homebridge';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const { host, port, password, maxAddr, verbose, invalidMaxAddr } = parseScanArgs(process.argv.slice(2));

if (!host) {
    console.error('Usage: node dist/scan.js <host> [port] [password] [--max-addr N] [--verbose]');
    process.exit(1);
}

if (invalidMaxAddr) {
    console.error(`[warn] --max-addr requires an integer in 1..999; falling back to default ${maxAddr}`);
}

// ─── silent logger ────────────────────────────────────────────────────────────

const log: Logging = {
    info:  () => {},
    debug: () => {},
    warn:  (...a: unknown[]) => { if (verbose) process.stderr.write(`[warn] ${a.join(' ')}\n`); },
    error: (...a: unknown[]) => process.stderr.write(`[error] ${a.join(' ')}\n`),
} as unknown as Logging;

// ─── Phase 1 : CONFIG scan ────────────────────────────────────────────────────
// Opens a CONFIG-mode connection and lists all configured physical devices.
// Not all gateways support this (F454/F455 do; MH200 may not).

interface ConfigDevice { raw: string; fields: string[] }

function configScan(): Promise<ConfigDevice[]> {
    return new Promise(resolve => {
        const devices: ConfigDevice[] = [];
        let phase   = 'INIT';
        let settled = false;

        const conn  = new OwnConnection(host, String(port), password, MODE.CONFIG, log);

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            conn.end();
            resolve(devices);
        };

        const timer = setTimeout(() => {
            if (verbose) console.error('[warn] CONFIG scan timed out after 10 s');
            finish();
        }, 10000);

        conn.on('connected', () => conn.sendPacket(CMD.SCAN));

        conn.on('packet', (pkt: string) => {
            if (phase === 'INIT') {
                if (pkt === PKT.ACK) { phase = 'RECV'; conn.sendPacket(CMD.SCAN_ALL); }
                return;
            }
            if (pkt === PKT.ACK) { finish(); return; }
            const m = pkt.match(/^\*#(.+)##$/);
            if (m) devices.push({ raw: pkt, fields: m[1].split('*') });
        });

        conn.on('close', finish);
        conn.connect();
    });
}

// ─── Phase 2 : STATUS scan ────────────────────────────────────────────────────
// Queries each address individually in COMMAND mode.
// Discovery requires an ACK and a matching state/dimension response. An ACK alone
// confirms gateway acceptance, not the existence of an actuator at the address.

// ─── config generation ────────────────────────────────────────────────────────

interface DraftConfig {
    lights:      Array<{ id: number; name: string }>;
    blinds:      Array<{ id: number; name: string; time: number }>;
    thermostats: Array<{ id: number; zone: number; name: string }>;
    contacts:    Array<{ id: number; name: string; protocol?: 'dry-contact'; where?: string }>;
    energies:    Array<{ id: number; name: string }>;
}

function buildConfig(found: ScanFound[]): DraftConfig {
    const draft: DraftConfig = { lights: [], blinds: [], thermostats: [], contacts: [], energies: [] };

    // Sort by WHO then address for deterministic output
    found.sort((a, b) => a.who - b.who || parseInt(a.where, 10) - parseInt(b.where, 10));

    for (const { who, where } of found) {
        const id = parseInt(where, 10);
        if (isNaN(id)) continue;
        switch (who) {
            case 1:  draft.lights.push({ id, name: `Light ${id}` }); break;
            case 2:  draft.blinds.push({ id, name: `Blind ${id}`, time: 20 }); break;
            case 4:  draft.thermostats.push({ id, zone: id, name: `Thermostat ${id}` }); break;
            case 9:  draft.contacts.push({ id, name: `Contact ${id}` }); break;
            case 18: draft.energies.push({ id, name: `Energy ${id}` }); break;
            case 25: draft.contacts.push({ id, name: `Contact ${id}`, protocol: 'dry-contact', where }); break;
        }
    }
    return draft;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\nMyHome device discovery — ${host}:${port}\n`);

    // Phase 1: CONFIG scan
    process.stdout.write('Phase 1/2 — CONFIG scan ... ');
    const cfgDevices = await configScan();
    console.log(`${cfgDevices.length} packet(s)`);
    if (verbose && cfgDevices.length > 0) {
        console.log('\nRaw CONFIG packets:');
        for (const d of cfgDevices) console.log(' ', d.raw);
        console.log();
    }

    // Phase 2: STATUS scan
    process.stdout.write(`Phase 2/2 — STATUS scan (addresses 1..${maxAddr}) ... `);
    const client = new OwnClient(host, String(port), password, log);
    client.maxConcurrent = 4;
    const found = await runStatusScan(client, maxAddr);
    console.log(`${found.length} device(s) found\n`);

    // Summary table
    if (found.length === 0) {
        console.log('No devices found.');
        console.log('Suggestions:');
        console.log('  • Check host/port/password');
        console.log(`  • Try a larger range: --max-addr 99`);
        console.log('  • Run with --verbose for connection details');
    } else {
        const whoLabel: Record<number, string> = { 1: 'light', 2: 'blind', 4: 'thermostat', 9: 'auxiliary', 18: 'energy', 25: 'contact/IR' };
        console.log('Discovered devices:');
        const sorted = [...found].sort((a, b) => a.who - b.who || parseInt(a.where, 10) - parseInt(b.where, 10));
        for (const { who, where } of sorted) {
            const type = whoLabel[who] ?? `WHO=${who}`;
            console.log(`  ${type.padEnd(12)} id=${where}`);
        }
        console.log();
    }

    // Draft config
    const draft = buildConfig(found);
    console.log('Draft config fragment (paste into your Homebridge platform config):');
    console.log();
    console.log(JSON.stringify(draft, null, 2));
    console.log();
    console.log('Before using this config:');
    console.log('  • Rename each entry to a meaningful name');
    console.log('  • Blinds: set "time" to the full travel time in seconds');
    console.log('  • Venetian blinds: add "timeSlat" and "slatPercent"');
    console.log('  • Thermostats: verify "zone" matches your installation');
    console.log('  • Dimmer lights: add "dimmer": true');
    console.log('  • Scenarios: add manually (scenario number and module WHERE address)');
    console.log();

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', errorMessage(err));
    process.exit(1);
});
