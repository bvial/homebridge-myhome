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

export interface ParsedStatus {
    type: WhoValue | null;
    id: number;
    status: boolean | number | null;
}

export interface PacketInfo {
    who: WhoValue | null;
    where: string | null;
}

export class OwnProtcol {
    static readonly reGen = /^\*([0-9]+)\*([0-9]+)\*([0-9]+)##$/i;
    static readonly reTemp = /^\*#4\*([0-9]+)\*0\*([0-9]+)##$/i;

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

    static getStatus(who: string | number, state: string | number): boolean | number | null {
        const whoInt = parseInt(String(who), 10);
        const stateInt = parseInt(String(state), 10);
        switch (whoInt) {
            case 1:
                switch (stateInt) {
                    case 0: return false;
                    case 1: return true;
                    default: return null;
                }
            case 2: return stateInt;
            case 4: return stateInt / 10;
            default: return null;
        }
    }

    static status(type: WhoValue | null, id: string, status: boolean | number | null): ParsedStatus {
        return { type, id: parseInt(id, 10), status };
    }

    static parseStatus(data: unknown): Partial<ParsedStatus> {
        if (typeof data !== 'string') return {};
        let response: RegExpMatchArray | null;
        if ((response = data.match(OwnProtcol.reGen))) {
            return OwnProtcol.status(OwnProtcol.getWhoType(response[1]), response[3], OwnProtcol.getStatus(response[1], response[2]));
        }
        if ((response = data.match(OwnProtcol.reTemp))) {
            return OwnProtcol.status(OwnProtcol.getWhoType('4'), response[1], OwnProtcol.decodeTemperature(response[2]));
        }
        return {};
    }

    static parseWHO(packet: string): WhoValue | null {
        let extract: RegExpMatchArray | null;
        if ((extract = packet.match(/^\*(\d*)\*.+##$/))) {
            return OwnProtcol.getWhoType(extract[1]);
        }
        if ((extract = packet.match(/^\*#(\d*)\*.+##$/))) {
            return OwnProtcol.getWhoType(extract[1]);
        }
        return null;
    }

    static parseWhere(packet: string): string | null {
        let extract: RegExpMatchArray | null;
        if ((extract = packet.match(/^\*\d*\*.+\*([\d#]+)##$/))) {
            return extract[1];
        }
        if ((extract = packet.match(/^\*#\d*\*([\d#]*)\*.+##$/))) {
            return extract[1];
        }
        return null;
    }

    static extractPacketInfo(packet: string): PacketInfo {
        let extract: RegExpMatchArray | null;
        if ((extract = packet.match(/^\*(\d*)\*.+\*([\d#]+)##$/))) {
            return { who: OwnProtcol.getWhoType(extract[1]), where: extract[2] };
        }
        if ((extract = packet.match(/^\*#(\d*)\*([\d#]*)\*.+##$/))) {
            return { who: OwnProtcol.getWhoType(extract[1]), where: extract[2] };
        }
        return { who: null, where: null };
    }

    static decodeTemperature(data: string): number {
        const m = data.match(/(\d)(\d\d)(\d)/);
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
