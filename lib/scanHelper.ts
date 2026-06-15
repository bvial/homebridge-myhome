import type { OwnClient } from './OwnNet';
import { PKT } from './OwnNet';
import { COMMAND_QUEUE_CAPACITY } from './utils';

export interface ScanFound {
    who: number;
    where: string;
    packets: string[];
}

/** OWN protocol maximum zone number for thermostat probes (WHO=4). */
export const THERMOSTAT_MAX_ZONE = 9;

/** Batch size kept safely below COMMAND_QUEUE_CAPACITY. */
const SCAN_BATCH = Math.floor(COMMAND_QUEUE_CAPACITY * 0.8);

/**
 * Probe the gateway for devices responding to status queries.
 * Sends *#WHO*WHERE## for WHO=1/2/9/18 on addresses 1..maxAddr,
 * and *#4*ZONE## for WHO=4 on zones 1..THERMOSTAT_MAX_ZONE.
 *
 * Detection rules:
 *   WHO=2 (blinds): ACK alone is sufficient (stopped blinds send no data packets).
 *   All other WHOs: ACK + at least 1 data packet required.
 */
export async function runStatusScan(client: OwnClient, maxAddr: number): Promise<ScanFound[]> {
    const found: ScanFound[] = [];
    const jobs: Array<{ who: number; where: string; command: string }> = [];

    for (let w = 1; w <= maxAddr; w++) {
        jobs.push({ who: 1,  where: String(w), command: `*#1*${w}##`      });  // light
        jobs.push({ who: 2,  where: String(w), command: `*#2*${w}##`      });  // blind
        jobs.push({ who: 9,  where: String(w), command: `*#9*${w}##`      });  // dry contact
        jobs.push({ who: 18, where: String(w), command: `*#18*${w}*113##` });  // energy (active power)
    }
    for (let w = 1; w <= THERMOSTAT_MAX_ZONE; w++) {
        jobs.push({ who: 4, where: String(w), command: `*#4*${w}##` });        // thermostat zone probe
    }

    for (let i = 0; i < jobs.length; i += SCAN_BATCH) {
        await Promise.all(jobs.slice(i, i + SCAN_BATCH).map(({ who, where, command }) =>
            new Promise<void>(resolve => {
                const pkts: string[] = [];
                client.sendCommand({
                    command,
                    stopon: [PKT.ACK, PKT.NACK],
                    packet: p => pkts.push(p),
                    done: pkt => {
                        if (pkt === PKT.NACK) { resolve(); return; }
                        if (pkt === PKT.ACK && (who === 2 || pkts.length > 0)) {
                            found.push({ who, where, packets: pkts });
                        }
                        resolve();
                    },
                });
            }),
        ));
    }
    return found;
}
