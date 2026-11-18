export const WHO = {
    scenario: 0,
    light: 1,
    automation: 2,
    load: 3,
    temperature: 4,
    alarm: 5,
    auxiliary: 9,
    videoDoor: 7,
    gateway: 13,
    soundSystem: 16,
    scene: 17,
    energy: 18,
    soundDiffusion: 22,
    CEN: 25,
    diagnostic: 1000,
    autoDiagnostic: 1001,
    heatingDiagnostic: 1004,
    deviceDiagnostic: 1013,
} as const;

export type WhoValue = typeof WHO[keyof typeof WHO];

export interface PacketInfo {
    who: WhoValue | null;
    where: string | null;
}

export interface LightState {
    where: string;
    on: boolean;
    brightness?: number;
}

export interface BlindReport {
    where: string;
    direction: 'opening' | 'closing' | 'stopped';
    /** Present only on DIM 10; 255 is explicitly unknown. */
    position?: number | null;
    blocked?: boolean;
}

export class OwnProtcol {
    static isWhere(value: unknown): value is string {
        return typeof value === 'string' && /^#?\d+(?:#\d+)*$/.test(value);
    }
    static getWhoType(who: string | number): WhoValue | null {
        const whoInt = parseInt(String(who), 10);
        switch (whoInt) {
            case 0: return WHO.scenario;
            case 1: return WHO.light;
            case 2: return WHO.automation;
            case 3: return WHO.load;
            case 4: return WHO.temperature;
            case 5: return WHO.alarm;
            case 7: return WHO.videoDoor;
            case 9: return WHO.auxiliary;
            case 13: return WHO.gateway;
            case 15:
            case 25: return WHO.CEN;
            case 16: return WHO.soundSystem;
            case 22: return WHO.soundDiffusion;
            case 17: return WHO.scene;
            case 18: return WHO.energy;
            case 1000: return WHO.diagnostic;
            case 1001: return WHO.autoDiagnostic;
            case 1004: return WHO.heatingDiagnostic;
            case 1013: return WHO.deviceDiagnostic;
            default: return null;
        }
    }

    static extractPacketInfo(packet: string): PacketInfo {
        if (!/^\*[\d#*]+##$/.test(packet)) return { who: null, where: null };
        const fields = packet.slice(1, -2).split('*');
        const dimension = fields[0].startsWith('#');
        const who = dimension ? fields[0].slice(1) : fields[0];
        if (!/^\d+$/.test(who)) return { who: null, where: null };
        return { who: OwnProtcol.getWhoType(who), where: fields[dimension ? 1 : 2] ?? null };
    }

    /** Decode absolute light state; relative/timing WHATs must not become percentages. */
    static decodeLightState(packet: string): LightState | null {
        const dimension = packet.match(/^\*#1\*([\d#]+)\*1\*(\d+)\*(\d+)##$/);
        if (dimension) {
            const level = Number(dimension[2]);
            if (level < 100 || level > 200 || Number(dimension[3]) > 255) return null;
            return { where: dimension[1], on: level > 100, brightness: level - 100 };
        }
        const standard = packet.match(/^\*1\*(?:1000#)?(\d+)(?:#[\d#]+)?\*([\d#]+)##$/);
        if (!standard) return null;
        const what = Number(standard[1]);
        if (what === 0 || what === 1) return { where: standard[2], on: what === 1 };
        if (what >= 2 && what <= 10) return { where: standard[2], on: true, brightness: what * 10 };
        if ((what >= 11 && what <= 18) || (what >= 20 && what <= 29)) return { where: standard[2], on: true };
        return null;
    }

    static decodeBlindReport(packet: string): BlindReport | null {
        const dimension = packet.match(/^\*#2\*([\d#]+)\*10\*(\d+)\*(\d+)\*(\d+)\*(\d+)##$/);
        if (dimension) {
            const status = Number(dimension[2]);
            const position = Number(dimension[3]);
            const info = Number(dimension[5]);
            if (status < 10 || status > 14 || (position > 100 && position !== 255)
                || Number(dimension[4]) > 7 || ![0, 12, 13, 14, 15].includes(info)) return null;
            return { where: dimension[1], direction: status === 10 ? 'stopped' : status === 11 || status === 13 ? 'opening' : 'closing',
                position: position === 255 ? null : position, blocked: [12, 13, 14].includes(info) };
        }
        const standard = packet.match(/^\*2\*(?:1000#)?(0|1|2|10|11|12)(?:#[\d#]+)?\*([\d#]+)##$/);
        if (!standard) return null;
        const what = Number(standard[1]) % 10;
        return { where: standard[2], direction: what === 0 ? 'stopped' : what === 1 ? 'opening' : 'closing' };
    }

    static decodeTemperature(data: string): number {
        const m = data.match(/^([01])(\d\d)(\d)$/);
        if (!m) return 0;
        let temperature = parseInt(m[2], 10) + (parseInt(m[3], 10) / 10);
        if (m[1] !== '0') {
            temperature *= -1;
        }
        return temperature;
    }

    static encodeTemperature(data: number): string {
        if (!Number.isFinite(data)) {
            throw new RangeError(`encodeTemperature: value must be a finite number, got ${data}`);
        }
        const clamped = Math.max(-99.9, Math.min(99.9, data));
        if (clamped >= 0) {
            return '0' + String(Math.round(clamped * 10)).padStart(3, '0');
        } else {
            return '1' + String(Math.round(clamped * -10)).padStart(3, '0');
        }
    }
}
