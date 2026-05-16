import { EventEmitter } from 'events';
import * as net from 'net';
import type { Logging } from 'homebridge';

export const STATE = {
    UNCONNECTED: 'UNCONNECTED',
    CONNECTING: 'CONNECTING',
    LOGGING_IN: 'LOGGING_IN',
    CONNECTED: 'CONNECTED',
} as const;
type StateValue = typeof STATE[keyof typeof STATE];

export const MODE = {
    MONITOR: 'MONITOR',
    COMMAND: 'COMMAND',
    CONFIG: 'CONFIG',
} as const;
export type ModeValue = typeof MODE[keyof typeof MODE];

const DIR = {
    IN: 'IN',
    OUT: 'OUT',
} as const;

export const PKT = {
    ACK: '*#*1##',
    NACK: '*#*0##',
} as const;

export const CMD = {
    START_CONFIG: '*99*0##',
    START_COMMAND: '*99*9##',
    START_MONITOR: '*99*1##',
    SCAN: '*1001*12*0##',
    SCAN_ALL: '*#1001*0*13##',
    SCAN_UNCONFIGURED: '*#1001*0*13#0##',
    START_CONFIGURED: '*#1001*0*13#1##',
} as const;

export interface CommandParams {
    command: string;
    stopon?: string | string[];
    packet?: (pkt: string) => void;
    done?: (pkt: string | null, index: number) => void;
    started?: () => void;
    log?: Logging;
    id?: string;
}

let idCount = 0;

export function calcPass(pass: string | undefined, nonce: string): string {
    let flag = true; let num1 = 0x0; let num2 = 0x0;
    const password = Number(pass);
    if (!Number.isInteger(password)) throw new Error('OWN password must be a number (got non-numeric value)');
    for (const c of nonce) {
        if (c !== '0') {
            if (flag) num2 = password;
            flag = false;
        }
        switch (c) {
            case '1': num1 = num2 & 0xFFFFFF80; num1 = num1 >>> 7; num2 = num2 << 25; num1 = num1 + num2; break;
            case '2': num1 = num2 & 0xFFFFFFF0; num1 = num1 >>> 4; num2 = num2 << 28; num1 = num1 + num2; break;
            case '3': num1 = num2 & 0xFFFFFFF8; num1 = num1 >>> 3; num2 = num2 << 29; num1 = num1 + num2; break;
            case '4': num1 = num2 << 1; num2 = num2 >>> 31; num1 = num1 + num2; break;
            case '5': num1 = num2 << 5; num2 = num2 >>> 27; num1 = num1 + num2; break;
            case '6': num1 = num2 << 12; num2 = num2 >>> 20; num1 = num1 + num2; break;
            case '7': num1 = num2 & 0x0000FF00; num1 = num1 + ((num2 & 0x000000FF) << 24); num1 = num1 + ((num2 & 0x00FF0000) >>> 16); num2 = (num2 & 0xFF000000) >>> 8; num1 = num1 + num2; break;
            case '8': num1 = num2 & 0x0000FFFF; num1 = num1 << 16; num1 = num1 + (num2 >>> 24); num2 = num2 & 0x00FF0000; num2 = num2 >>> 8; num1 = num1 + num2; break;
            case '9': num1 = ~num2; break;
            case '0': num1 = num2; break;
        }
        num2 = num1;
    }
    return (num1 >>> 0).toString();
}

export class OwnConnection extends EventEmitter {
    id: string;
    host: string;
    port: number;
    password: string;
    conn: net.Socket | null;
    buf: string;
    state: StateValue;
    mode: ModeValue;
    log: Logging;

    constructor(host: string, port: string | number, password: string, mode: ModeValue, log: Logging) {
        super();
        idCount++;
        this.id = idCount.toString();
        this.host = host;
        this.port = parseInt(String(port), 10);
        this.password = password;
        this.conn = null;
        this.buf = '';
        this.state = STATE.UNCONNECTED;
        this.mode = mode;
        this.log = log;
    }

    connect(): void {
        if (this.conn) {
            this.log.debug('conn:%s destroy old socket', this.id);
            this.conn.removeAllListeners();
            this.conn.on('error', () => {});
            this.conn.destroy();
            this.conn = null;
        }
        this.buf = '';
        this.log.debug('conn:%s open socket host: %s, port:%s ', this.id, this.host, this.port);
        this.conn = net.connect({ host: this.host, port: this.port });
        this.conn.setKeepAlive(true, 30000);
        this.conn.on('data', this.onData.bind(this));
        this.conn.on('error', (error: Error) => {
            this.log.error('Socket error: %s', error.message);
            this.state = STATE.UNCONNECTED;
        });
        this.conn.on('close', () => {
            this.state = STATE.UNCONNECTED;
            const socket = this.conn;
            this.conn = null;
            if (socket) {
                socket.removeAllListeners();
                socket.on('error', () => {});
            }
            this.emit('close');
        });
    }

    setTimeout(time: number): void {
        if (this.conn) {
            this.conn.removeAllListeners('timeout');
            this.conn.setTimeout(time);
            this.conn.once('timeout', () => {
                this.log.debug('conn:%s socket timeout', this.id);
                this.end();
            });
        }
    }

    end(): void {
        if (this.conn) {
            this.log.debug('conn:%s end', this.id);
            this.conn.removeAllListeners();
            this.conn.on('error', () => {});
            this.conn.destroy();
            this.conn = null;
        }
    }

    logPacket(direction: string, packet: string): void {
        if (this.state === STATE.CONNECTING || this.state === STATE.LOGGING_IN) {
            this.log.debug('conn:%s mode:%s dir:%s data:[auth]', this.id, this.mode, direction);
        } else {
            this.log.debug('conn:%s mode:%s dir:%s data:%s', this.id, this.mode, direction, packet);
        }
    }

    sendPacket(packet: string): void {
        this.logPacket(DIR.OUT, packet);
        if (this.conn) this.conn.write(packet);
    }

    onData(data: Buffer | string): void {
        this.buf += data.toString();

        while (this.buf.length > 0) {
            const m = this.buf.match(/(\*.+?##)([\s\S]*)/);
            if (!m) {
                if (this.buf.length > 4096) {
                    this.log.warn('conn:%s buffer overflow (%d bytes), discarding', this.id, this.buf.length);
                    this.buf = '';
                }
                break;
            }
            const packet = m[1];
            this.buf = m[2];

            this.logPacket(DIR.IN, packet);
            switch (this.state) {
                case STATE.UNCONNECTED:
                    if (packet === PKT.ACK) {
                        this.emit('connecting');
                        this.state = STATE.CONNECTING;
                        this.log.debug('conn:%s new connection', this.id);
                        switch (this.mode) {
                            case MODE.MONITOR: this.sendPacket(CMD.START_MONITOR); break;
                            case MODE.COMMAND: this.sendPacket(CMD.START_COMMAND); break;
                            case MODE.CONFIG: this.sendPacket(CMD.START_CONFIG); break;
                        }
                    }
                    break;
                case STATE.CONNECTING:
                    if (packet === PKT.ACK) {
                        this.emit('connected');
                        this.state = STATE.CONNECTED;
                        this.log.debug('conn:%s start unauthenticated connection', this.id);
                    } else {
                        const loginMatch = packet.match(/\*#(\d+)##/);
                        if (loginMatch === null) {
                            this.log.error("conn:%s Unable to recognize packet '%s'", this.id, packet);
                        } else {
                            this.emit('logging-in');
                            this.log.debug('conn:%s send password', this.id);
                            try {
                                const p = calcPass(this.password, loginMatch[1]);
                                this.state = STATE.LOGGING_IN;
                                if (this.conn) this.conn.write(`*#${p}##`);
                            } catch (err) {
                                this.log.error('conn:%s Password error: %s', this.id, (err as Error).message);
                                this.state = STATE.UNCONNECTED;
                                this.emit('auth-failed');
                                this.end();
                                return;
                            }
                        }
                    }
                    break;
                case STATE.LOGGING_IN:
                    if (packet === PKT.ACK) {
                        this.emit('connected');
                        this.state = STATE.CONNECTED;
                        this.log.debug('conn:%s start authenticated connection', this.id);
                    } else if (packet === PKT.NACK) {
                        this.log.error('conn:%s Authentication failed (wrong password)', this.id);
                        this.state = STATE.UNCONNECTED;
                        this.emit('auth-failed');
                        this.end();
                        return;
                    } else {
                        this.log.error('conn:%s Got unexpected packet in login phase', this.id);
                    }
                    break;
                case STATE.CONNECTED:
                    this.emit('packet', packet);
                    break;
            }
        }
    }
}

export class OwnMonitor extends EventEmitter {
    client: OwnClient;
    connection: OwnConnection | null;
    checkTimeout: NodeJS.Timeout | undefined;
    reconnectTimeout: NodeJS.Timeout | undefined;
    nbCheck: number;
    reconnectSeconds: number;
    reconnectAttempts: number;
    authFailed: boolean;

    constructor(client: OwnClient) {
        super();
        this.client = client;
        this.connection = null;
        this.checkTimeout = undefined;
        this.reconnectTimeout = undefined;
        this.nbCheck = 0;
        this.reconnectSeconds = 30;
        this.reconnectAttempts = 0;
        this.authFailed = false;
    }

    connect(): void {
        this.nbCheck = 0;
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
        this.client.log.info('Start monitoring MyHome server');
        if (this.connection !== null) {
            this.connection.removeAllListeners();
            this.connection.end();
            this.connection = null;
        }
        this.connection = this.client.newConnection(MODE.MONITOR);
        this.connection.on('connected', () => {
            this.reconnectAttempts = 0;
            this.authFailed = false;
            this.emit('connected');
        });
        this.connection.on('auth-failed', () => {
            this.authFailed = true;
        });
        this.connection.on('close', () => {
            this.emit('close');
        });
        this.connection.on('packet', (data: string) => {
            this.resetAutoConnectTimeout();
            this.emit('packet', data);
        });
        this.connection.connect();
        this.resetCheck();
        this.resetAutoConnectTimeout();
    }

    checkMonitor(): void {
        this.client.sendCommand({
            command: '*#13**15##',
            stopon: PKT.ACK,
            done: (pkt: string | null) => {
                if (pkt !== null) {
                    const connAlive = this.connection !== null && this.connection.state === STATE.CONNECTED;
                    if (!connAlive) {
                        this.client.log.warn('Monitor: keep-alive OK but monitor disconnected, reconnecting now');
                        this.reconnectAttempts++;
                        this.connect();
                    } else {
                        this.client.log.debug('Monitor: keep-alive acknowledged, connection healthy');
                        this.resetCheck();
                        this.resetAutoConnectTimeout();
                    }
                }
            },
        });
    }

    resetCheck(): void {
        this.nbCheck = 0;
    }

    resetAutoConnectTimeout(): void {
        if (this.checkTimeout !== undefined) clearTimeout(this.checkTimeout);
        this.checkTimeout = setTimeout(this.restartConnection.bind(this), this.reconnectSeconds * 1000);
    }

    restartConnection(): void {
        if (this.authFailed) {
            this.client.log.error('Monitor: authentication failed, not reconnecting (check password)');
            return;
        }
        if (this.nbCheck < 3) {
            this.nbCheck++;
            this.checkMonitor();
            this.resetAutoConnectTimeout();
        } else {
            clearTimeout(this.checkTimeout);
            this.checkTimeout = undefined;
            this.reconnectAttempts++;
            const delaySec = Math.min(this.reconnectSeconds * this.reconnectAttempts, 300);
            this.client.log.error('Monitor connection is dead, reconnecting in %ds (attempt #%d)', delaySec, this.reconnectAttempts);
            this.reconnectTimeout = setTimeout(() => this.connect(), delaySec * 1000);
        }
    }
}

export class OwnClient extends EventEmitter {
    host: string;
    password: string;
    port: string | number;
    monitor: OwnMonitor | null;
    log: Logging;
    commandQueue: CommandParams[];
    activeCommands: number;
    maxConcurrent: number;

    constructor(host: string, port: string | number, password: string, log: Logging) {
        super();
        this.host = host;
        this.password = password;
        this.port = port;
        this.monitor = null;
        this.log = log;
        this.commandQueue = [];
        this.activeCommands = 0;
        this.maxConcurrent = 2;
    }

    newConnection(mode: ModeValue, log?: Logging): OwnConnection {
        return new OwnConnection(this.host, this.port, this.password, mode, log || this.log);
    }

    queueSize(): number {
        return this.commandQueue.length;
    }

    sendCommand(params: CommandParams): void {
        if (this.commandQueue.length >= 50) {
            this.log.warn('Command queue full (%d), dropping: %s', this.commandQueue.length, params.command);
            return;
        }
        this.commandQueue.push(params);
        this.processQueue();
    }

    processQueue(): void {
        while (this.activeCommands < this.maxConcurrent && this.commandQueue.length > 0) {
            this.activeCommands++;
            const params = this.commandQueue.shift();
            if (params === undefined) return;
            this.executeCommand(params);
        }
    }

    releaseSlot(): void {
        if (this.activeCommands > 0) this.activeCommands--;
        this.processQueue();
    }

    executeCommand(params: CommandParams): void {
        let released = false;
        const releaseSlot = (failed: boolean) => {
            if (!released) {
                released = true;
                if (failed && params.done) params.done(null, -1);
                this.releaseSlot();
            }
        };

        let cmdTimeout: ReturnType<typeof setTimeout> | undefined;
        const commandconn = this.newConnection(MODE.COMMAND, params.log);
        commandconn.on('connected', () => {
            commandconn.sendPacket(params.command);
            if (params.started) params.started();
            cmdTimeout = setTimeout(() => {
                commandconn.log.debug('conn:%s command timeout', commandconn.id);
                commandconn.end();
                releaseSlot(true);
            }, 10000);
        });
        commandconn.on('packet', (packet: string) => {
            const done = (pkt: string, index: number) => {
                clearTimeout(cmdTimeout);
                commandconn.end();
                releaseSlot(false);
                if (params.done) params.done(pkt, index);
            };

            if (params.stopon !== undefined) {
                if (Array.isArray(params.stopon)) {
                    const i = params.stopon.indexOf(packet);
                    if (i !== -1) return done(packet, i);
                } else if (packet === params.stopon) {
                    return done(packet, 0);
                }
            } else if (packet === PKT.ACK) {
                return done(packet, 0);
            }
            if (params.packet) params.packet(packet);
        });
        commandconn.on('close', () => {
            clearTimeout(cmdTimeout);
            releaseSlot(true);
        });
        commandconn.connect();
    }

    startMonitor(): void {
        this.monitor = new OwnMonitor(this);
        this.monitor.on('connected', () => {
            this.emit('monitoring');
        });
        this.monitor.on('packet', (data: string) => {
            this.emit('packet', data);
        });
        this.monitor.on('close', () => {
            this.emit('unmonitoring');
        });
        this.monitor.connect();
    }

    private runScan(cmd: string, callback?: (macs: number[]) => void): void {
        const SCAN_INIT = 0;
        const SCAN_RECEIVE = 1;
        let state = SCAN_INIT;
        const macs: number[] = [];
        let done = false;
        const finish = (result: number[]) => {
            if (!done) {
                done = true;
                clearTimeout(scanTimeout);
                if (callback) callback(result);
            }
        };
        const confconn = this.newConnection(MODE.CONFIG);
        const scanTimeout = setTimeout(() => {
            this.log.warn('runScan: timeout after 30s, aborting');
            confconn.end();
            finish([]);
        }, 30000);
        confconn.on('connected', () => {
            confconn.sendPacket(CMD.SCAN);
        });
        confconn.on('packet', (pkt: string) => {
            switch (state) {
                case SCAN_INIT:
                    if (pkt === PKT.ACK) {
                        state = SCAN_RECEIVE;
                        confconn.log.debug('Start scan');
                        confconn.sendPacket(cmd);
                    } else {
                        this.log.error(`unexpected packet expected '${PKT.ACK}' got '${pkt}'`);
                    }
                    break;
                case SCAN_RECEIVE:
                    if (pkt === PKT.ACK) {
                        confconn.end();
                        finish(macs);
                    } else {
                        const m = pkt.match(/\*#(\d+)\*(\d+)\*(\d+)\*(\d+)##/);
                        if (m) {
                            macs.push(parseInt(m[4], 10));
                        } else {
                            this.log.debug(`scan: skipping unknown packet: ${pkt}`);
                        }
                    }
                    break;
            }
        });
        confconn.on('close', () => {
            this.log.warn('runScan: connection closed unexpectedly, aborting');
            finish([]);
        });
        confconn.connect();
    }

    detectGatewayModel(callback: (model: string | null) => void): void {
        const collected: string[] = [];
        this.sendCommand({
            command: '*#13**0##',
            stopon: [PKT.ACK, PKT.NACK],
            packet: (pkt) => { collected.push(pkt); },
            done: (pkt) => {
                if (pkt === null || pkt === PKT.NACK) { callback(null); return; }
                for (const p of collected) {
                    const m = p.match(/^\*#13\*\*0\*(.+?)##$/);
                    if (m) { callback(m[1].trim()); return; }
                }
                callback(null);
            },
        });
    }

    scanSystem(callback?: (macs: number[]) => void): void {
        this.runScan(CMD.SCAN_ALL, callback);
    }

    scanUnconfigured(callback?: (macs: number[]) => void): void {
        this.runScan(CMD.SCAN_UNCONFIGURED, callback);
    }

    scanConfigured(callback?: (macs: number[]) => void): void {
        this.runScan(CMD.START_CONFIGURED, callback);
    }
}
