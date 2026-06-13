import type { API, DynamicPlatformPlugin, HapStatusError, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from './constants';
import { errorMessage, STATUS_UPDATE_STAGGER_MS, isValidConfig } from './utils';
import { OwnClient } from './OwnNet';
import { OwnProtcol, WHO } from './OwnProtcol';
import {
    OwnLightAccessory,
    OwnBlindAccessory,
    OwnThermostatAccessory,
    OwnScenarioAccessory,
    OwnContactAccessory,
    OwnEnergyAccessory,
    OwnDoorAccessory,
    OwnPlatformLike,
    LightConfig,
    BlindConfig,
    ThermostatConfig,
    ScenarioConfig,
    ContactConfig,
    EnergyConfig,
    DoorConfig,
} from './OwnAccessory';

interface MyHomeConfig extends PlatformConfig {
    host?: string;
    port?: number;
    password?: string;
    maxConcurrent?: number;
    doors?: DoorConfig[];
    lights?: LightConfig[];
    blinds?: BlindConfig[];
    thermostats?: ThermostatConfig[];
    scenarios?: ScenarioConfig[];
    contacts?: ContactConfig[];
    energies?: EnergyConfig[];
}

type AnyAccessory = OwnLightAccessory | OwnBlindAccessory | OwnThermostatAccessory
    | OwnScenarioAccessory | OwnContactAccessory | OwnEnergyAccessory | OwnDoorAccessory;

// Model codes from *#13**15## (DIM 15 = Device Type). Codes 2–13 per OWN spec; 200 = F454 (post-2006).
const MODEL_NAMES: Record<number, string> = {
    2: 'MHServer', 4: 'MH200', 6: 'F452', 7: 'F452V',
    11: 'MHServer2', 13: 'H4684', 200: 'F454',
};

function recommendedConcurrency(model: string | null): number {
    if (model === null) return 2;
    const code = parseInt(model, 10);
    if (isNaN(code)) return 2;
    if (code === 200) return 4;              // F454
    if (code === 6 || code === 7) return 3;  // F452, F452V
    if (code === 4) return 3;                // MH200
    return 2;                                // MHServer, MHServer2, H4684, unknown
}

function modelLabel(code: string | null): string {
    if (code === null) return 'unknown';
    const n = parseInt(code, 10);
    const name = MODEL_NAMES[n];
    return name ? `${name} (code ${code})` : `unknown (code ${code})`;
}

export class OwnPlatform implements DynamicPlatformPlugin {
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly HapStatusError: new (status: number) => HapStatusError;
    readonly HAPStatus: Record<string, number>;
    cachedAccessories: PlatformAccessory[];
    activeHandlers: AnyAccessory[];
    controller: OwnClient | undefined;
    private staggerTimers: ReturnType<typeof setTimeout>[];
    private readonly config: Required<Omit<MyHomeConfig, 'host' | 'maxConcurrent' | 'password'>> & { host?: string; password?: string; maxConcurrent?: number };

    constructor(
        public readonly log: Logging,
        config: PlatformConfig,
        public readonly api: API,
    ) {
        const defaultConfig: Omit<MyHomeConfig, keyof PlatformConfig> = {
            port: 20000,
            doors: [],
            lights: [],
            blinds: [],
            thermostats: [],
            scenarios: [],
            contacts: [],
            energies: [],
        };

        this.config = { ...defaultConfig, ...config } as Required<Omit<MyHomeConfig, 'host' | 'maxConcurrent' | 'password'>> & { host?: string; password?: string; maxConcurrent?: number };

        this.Service = api.hap.Service as typeof Service;
        this.Characteristic = api.hap.Characteristic as typeof Characteristic;
        this.HapStatusError = api.hap.HapStatusError as unknown as new (status: number) => HapStatusError;
        this.HAPStatus = {
            NOT_ALLOWED_IN_CURRENT_STATE: -70412,
            SERVICE_COMMUNICATION_FAILURE: -70402,
            RESOURCE_BUSY: -70403,
            OPERATION_TIMED_OUT: -70408,
        };
        this.cachedAccessories = [];
        this.activeHandlers = [];
        this.staggerTimers = [];

        if (!this.config.host) {
            this.log.error('homebridge-myhome: missing required config "host" — plugin will not start');
            api.on('didFinishLaunching', () => {
                if (this.cachedAccessories.length > 0) {
                    this.log.warn('Removing %d stale accessories (no host configured)', this.cachedAccessories.length);
                    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.cachedAccessories);
                    this.cachedAccessories = [];
                }
            });
            return;
        }

        this.log.info(`LegrandMyHome for MyHome Gateway at ${this.config.host}:${this.config.port} (Homebridge ${api.serverVersion})`);
        this.controller = new OwnClient(
            this.config.host,
            this.config.port ?? 20000,
            this.config.password ?? '',
            this.log,
        );
        api.on('didFinishLaunching', () => {
            const ctrl = this.controller;
            if (!ctrl) return;
            this.discoverDevices();
            ctrl.on('packet', this.onMonitor.bind(this));
            ctrl.on('monitoring', () => {
                this.log.success('Gateway connected — monitoring active');
                this.setAllOnline(true);
                this.updateAccessoriesStatus();
            });
            ctrl.on('unmonitoring', () => { this.setAllOnline(false); });
            ctrl.on('auth-failed', () => {
                this.log.error('Gateway authentication failed — check password. Plugin will not reconnect until Homebridge restarts.');
                this.setAllOnline(false);
            });
            ctrl.detectGatewayModel((model) => {
                const userOverride = this.config.maxConcurrent;
                const label = modelLabel(model);
                if (typeof userOverride === 'number' && Number.isInteger(userOverride) && userOverride >= 1 && userOverride <= 10) {
                    ctrl.maxConcurrent = userOverride;
                    this.log.info(`maxConcurrent set to ${ctrl.maxConcurrent} (user override; gateway: ${label})`);
                } else {
                    ctrl.maxConcurrent = recommendedConcurrency(model);
                    this.log.info(`maxConcurrent auto-set to ${ctrl.maxConcurrent} (gateway: ${label})`);
                }
                // Propagate detected gateway model to each accessory's HardwareRevision
                for (const handler of this.activeHandlers) handler.setHardwareRevision(label);
                ctrl.startMonitor();
            });
        });

        api.on('shutdown', () => {
            for (const t of this.staggerTimers) clearTimeout(t);
            this.staggerTimers = [];
            for (const handler of this.activeHandlers) handler.destroy();
            this.activeHandlers = [];
            this.controller?.stopMonitor();
        });
    }

    configureAccessory(accessory: PlatformAccessory): void {
        this.log.info('Restoring cached accessory:', accessory.displayName);
        this.cachedAccessories.push(accessory);
        // Note: handler creation is deferred to discoverDevices() which has the up-to-date
        // config.device. Creating here with stale context.device would skip the service-flip
        // cleanup when the user changes asButton/asOutlet/sensorType in config.
    }

    discoverDevices(): void {
        this.log.info('Discovering OpenWebNet devices from config');

        // HAP category codes hardcoded (Categories is a const enum — no runtime object):
        // 5=Lightbulb, 6=DoorLock, 7=Outlet, 8=Switch, 9=Thermostat, 10=Sensor, 14=WindowCovering, 15=ProgrammableSwitch
        function deviceCategory(d: { type: string } & Record<string, unknown>): number {
            if (d.type === 'scenario' && d.asButton) return 15;
            if (d.type === 'energy'   && d.asOutlet) return 7;
            const base: Record<string, number> = {
                light: 5, blind: 14, thermostat: 9, scenario: 8, contact: 10, energy: 10, door: 6,
            };
            return base[d.type] ?? 1;
        }

        const allDevices = [
            ...(this.config.lights ?? []).map((d: LightConfig) => ({ ...d, type: 'light' as const })),
            ...(this.config.blinds ?? []).map((d: BlindConfig) => ({ ...d, type: 'blind' as const })),
            ...(this.config.thermostats ?? []).map((d: ThermostatConfig) => ({ ...d, type: 'thermostat' as const })),
            ...(this.config.scenarios ?? []).map((d: ScenarioConfig) => ({ ...d, type: 'scenario' as const })),
            ...(this.config.contacts ?? []).map((d: ContactConfig) => ({ ...d, type: 'contact' as const })),
            ...(this.config.energies ?? []).map((d: EnergyConfig) => ({ ...d, type: 'energy' as const })),
            ...(this.config.doors ?? []).map((d: DoorConfig) => ({ ...d, type: 'door' as const })),
        ];

        const discoveredUUIDs: string[] = [];

        for (const device of allDevices) {
            const uuid = this.api.hap.uuid.generate(`myhome-${device.type}-${device.id}`);
            if (discoveredUUIDs.includes(uuid)) {
                this.log.warn('Duplicate accessory %s id=%s in config — skipping', device.type, device.id);
                continue;
            }
            discoveredUUIDs.push(uuid);

            const existingAccessory = this.cachedAccessories.find(a => a.UUID === uuid);

            if (existingAccessory) {
                this.log.info('Restoring accessory from cache:', existingAccessory.displayName);
                existingAccessory.context.device = device;
                existingAccessory.context.type = device.type;
                // Refresh category in case the user toggled asButton/asOutlet/etc. between sessions.
                existingAccessory.category = (deviceCategory(device) ?? 1) as unknown as typeof existingAccessory.category;
                this.api.updatePlatformAccessories([existingAccessory]);
                if (!this.activeHandlers.find(h => h.accessory === existingAccessory)) {
                    try {
                        this.createHandler(device.type, existingAccessory, device);
                    } catch (err) {
                        this.log.error('Failed to create handler for %s id=%s: %s', device.type, device.id, errorMessage(err));
                    }
                }
            } else {
                const name = device.name ?? `${device.type}-${device.id}`;
                this.log.info('Adding new accessory:', name);
                const accessory = new this.api.platformAccessory(name, uuid);
                accessory.category = (deviceCategory(device) ?? 1) as unknown as typeof accessory.category;
                accessory.context.device = device;
                accessory.context.type = device.type;
                try {
                    this.createHandler(device.type, accessory, device);
                    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                } catch (err) {
                    this.log.error('Failed to create handler for %s id=%s: %s', device.type, device.id, errorMessage(err));
                }
            }
        }

        const stale = this.cachedAccessories.filter(a => !discoveredUUIDs.includes(a.UUID));
        if (stale.length > 0) {
            this.log.info('Removing %d stale accessories', stale.length);
            for (const accessory of stale) {
                const idx = this.activeHandlers.findIndex(h => h.accessory === accessory);
                if (idx !== -1) {
                    this.activeHandlers[idx].destroy();
                    this.activeHandlers.splice(idx, 1);
                }
            }
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
            this.cachedAccessories = this.cachedAccessories.filter(a => discoveredUUIDs.includes(a.UUID));
        }
    }

    createHandler(type: string, accessory: PlatformAccessory, config: Record<string, unknown>): void {
        if (!isValidConfig(config)) {
            this.log.warn('createHandler: invalid config for type "%s" — skipping (%j)', type, config);
            return;
        }
        const platform = this as unknown as OwnPlatformLike;
        let handler: AnyAccessory | undefined;
        switch (type) {
            case 'light': handler = new OwnLightAccessory(platform, accessory, config as unknown as LightConfig); break;
            case 'blind': handler = new OwnBlindAccessory(platform, accessory, config as unknown as BlindConfig); break;
            case 'thermostat': handler = new OwnThermostatAccessory(platform, accessory, config as unknown as ThermostatConfig); break;
            case 'scenario': handler = new OwnScenarioAccessory(platform, accessory, config as unknown as ScenarioConfig); break;
            case 'contact': handler = new OwnContactAccessory(platform, accessory, config as unknown as ContactConfig); break;
            case 'energy': handler = new OwnEnergyAccessory(platform, accessory, config as unknown as EnergyConfig); break;
            case 'door': handler = new OwnDoorAccessory(platform, accessory, config as unknown as DoorConfig); break;
            default:
                this.log.warn('createHandler: unknown device type "%s" — skipping', type);
                return;
        }
        if (handler) this.activeHandlers.push(handler);
    }

    onMonitor(packet: string): void {
        try {
            const info = OwnProtcol.extractPacketInfo(packet);
            switch (info.who) {
                case WHO.light:
                case WHO.automation:
                case WHO.temperature:
                case WHO.auxiliary:
                case WHO.energy:
                case WHO.videoDoor:
                    this.onAccessory(info.who, info.where, packet);
                    break;
                case WHO.gateway:
                    this.log.debug('Gateway packet', packet);
                    break;
                case WHO.scenario:
                case WHO.CEN:
                case WHO.load:
                case WHO.alarm:
                case WHO.scene:
                case WHO.soundSystem:
                case WHO.soundDiffusion:
                case WHO.diagnostic:
                case WHO.heatingDiagnostic:
                case WHO.deviceDiagnostic:
                case WHO.autoDiagnostic:
                    break;   // no accessory routing needed — silently ignored
                default:
                    this.log.debug('Unsupported packet', packet);
            }
        } catch (err) {
            this.log.error('Error processing packet %s: %s', packet, errorMessage(err));
        }
    }

    onAccessory(who: number | null, where: string | null, packet: string): void {
        if (!where) return;
        // Filter by both WHO and where: the same numeric `where` (e.g. id=42) can be used by
        // accessories of different WHO codes (light id=42 + door id=42). Without WHO filtering,
        // each cross-WHO packet would log "unknown packet" errors in mismatched accessories.
        const handlers = this.activeHandlers.filter(h => {
            if (who !== null && h.who !== null && h.who !== who) return false;
            return h.checkWhere(where);
        });
        if (handlers.length === 0) {
            this.log.debug('Accessory not found', where, packet);
            return;
        }
        for (const h of handlers) h.onData(packet);
    }

    updateAccessoriesStatus(): void {
        this.log.info('Fetching accessories status');
        for (const t of this.staggerTimers) clearTimeout(t);
        this.staggerTimers = [];
        let delay = 0;
        for (const handler of this.activeHandlers) {
            this.staggerTimers.push(setTimeout((h: AnyAccessory) => h.updateStatus(), delay, handler));
            delay += STATUS_UPDATE_STAGGER_MS;
        }
    }

    setAllOnline(online: boolean): void {
        for (const handler of this.activeHandlers) handler.setOnline(online);
    }

    /** OwnPlatformLike: notify Homebridge that an accessory's mutable state (e.g. displayName) changed. */
    updateAccessory(accessory: PlatformAccessory): void {
        this.api.updatePlatformAccessories([accessory]);
    }
}
