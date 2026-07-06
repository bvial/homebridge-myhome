import type { API, DynamicPlatformPlugin, HapStatusError, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from './constants';
import { errorMessage, STATUS_UPDATE_STAGGER_MS, isValidConfig } from './utils';
import { OwnClient } from './OwnNet';
import { OwnProtcol, WHO } from './OwnProtcol';
import { runStatusScan, ScanFound } from './scanHelper';
import {
    OwnLightAccessory,
    OwnBlindAccessory,
    OwnThermostatAccessory,
    OwnScenarioAccessory,
    OwnContactAccessory,
    OwnEnergyAccessory,
    OwnDoorAccessory,
    type OwnPlatformLike,
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
    autoDiscover?: boolean;
    autoDiscoverMaxAddr?: number;
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

// HAP category codes per accessory type for auto-discovered placeholders.
interface AutoDiscoverTypeInfo {
    type: string;
    category: number;
    makeConfig(id: number): Record<string, unknown>;
}

const AUTO_DISCOVER_TYPES: Record<number, AutoDiscoverTypeInfo> = {
    1:  { type: 'light',      category: 5,  makeConfig: (id) => ({ id, name: `Light ${id}` }) },
    2:  { type: 'blind',      category: 14, makeConfig: (id) => ({ id, name: `Blind ${id}`, time: 30, calibrateOnStart: false }) },
    4:  { type: 'thermostat', category: 9,  makeConfig: (id) => ({ id, name: `Thermostat ${id}`, zone: id }) },
    9:  { type: 'contact',    category: 10, makeConfig: (id) => ({ id, name: `Contact ${id}` }) },
    18: { type: 'energy',     category: 10, makeConfig: (id) => ({ id, name: `Energy ${id}` }) },
};

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

export class OwnPlatform implements DynamicPlatformPlugin, OwnPlatformLike {
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly HapStatusError: new (status: number) => HapStatusError;
    readonly HAPStatus: Record<string, number>;
    cachedAccessories: PlatformAccessory[];
    activeHandlers: AnyAccessory[];
    // OwnPlatformLike requires `controller: OwnClient` (non-optional). The field is
    // initialized in the constructor after we've verified `host` is configured, so
    // any code path that reaches an accessory handler is guaranteed to have it set.
    controller!: OwnClient;
    private staggerTimers: ReturnType<typeof setTimeout>[];
    private readonly config: Required<Omit<MyHomeConfig, 'host' | 'maxConcurrent' | 'password'>> & { host?: string; password?: string; maxConcurrent?: number };

    constructor(
        public readonly log: Logging,
        config: PlatformConfig,
        public readonly api: API,
    ) {
        const defaultConfig: Omit<MyHomeConfig, keyof PlatformConfig> = {
            port: 20000,
            autoDiscover: false,
            autoDiscoverMaxAddr: 20,
            doors: [],
            lights: [],
            blinds: [],
            thermostats: [],
            scenarios: [],
            contacts: [],
            energies: [],
        };

        this.config = { ...defaultConfig, ...config };

        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.HapStatusError = api.hap.HapStatusError;
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
                this.log.info('Gateway connected — monitoring active');
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
                if (this.config.autoDiscover) {
                    this.runAutoDiscovery(ctrl)
                        .then(() => ctrl.startMonitor())
                        .catch(err => {
                            this.log.error('[AutoDiscover] Scan failed: %s', errorMessage(err));
                            ctrl.startMonitor();
                        });
                } else {
                    ctrl.startMonitor();
                }
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
        this.log.debug('Restoring cached accessory:', accessory.displayName);
        this.cachedAccessories.push(accessory);
        // Note: handler creation is deferred to discoverDevices() which has the up-to-date
        // config.device. Creating here with stale context.device would skip the service-flip
        // cleanup when the user changes asOutlet/sensorType in config.
    }

    discoverDevices(): void {
        this.log.info('Discovering OpenWebNet devices from config');

        // HAP category codes hardcoded (Categories is a const enum — no runtime object):
        // 5=Lightbulb, 6=DoorLock, 7=Outlet, 8=Switch, 9=Thermostat, 10=Sensor, 14=WindowCovering
        function deviceCategory(d: { type: string } & Record<string, unknown>): number {
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
                this.log.debug('Restoring accessory from cache:', existingAccessory.displayName);
                existingAccessory.context.device = device;
                existingAccessory.context.type = device.type;
                // Refresh category in case the user toggled asOutlet/etc. between sessions.
                existingAccessory.category = deviceCategory(device) ?? 1;
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
                accessory.category = deviceCategory(device) ?? 1;
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

        const isKeeper = (a: PlatformAccessory): boolean => {
            if (discoveredUUIDs.includes(a.UUID)) return true;
            // Preserve auto-discovered accessories when autoDiscover is active;
            // runAutoDiscovery() will re-attach or clean them up after the scan.
            if (this.config.autoDiscover &&
                (a.context as Record<string, unknown>).autoDiscovered) return true;
            return false;
        };
        const stale = this.cachedAccessories.filter(a => !isKeeper(a));
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
            // Rebuild cachedAccessories with the same keeper rule (not just discoveredUUIDs)
            // so auto-discovered entries survive across `discoverDevices()` when autoDiscover
            // is enabled — otherwise they would remain registered in Homebridge but be
            // dropped from our in-memory cache, becoming "ghost" accessories.
            this.cachedAccessories = this.cachedAccessories.filter(isKeeper);
        }
    }

    createHandler(type: string, accessory: PlatformAccessory, config: Record<string, unknown>): void {
        if (!isValidConfig(config)) {
            this.log.warn('createHandler: invalid config for type "%s" — skipping (%j)', type, config);
            return;
        }
        // `this` satisfies OwnPlatformLike (see class declaration `implements OwnPlatformLike`),
        // so accessory constructors can accept it directly without a local alias.
        let handler: AnyAccessory | undefined;
        switch (type) {
            case 'light': handler = new OwnLightAccessory(this, accessory, config); break;
            case 'blind': handler = new OwnBlindAccessory(this, accessory, config as unknown as BlindConfig); break;
            case 'thermostat': handler = new OwnThermostatAccessory(this, accessory, config as unknown as ThermostatConfig); break;
            case 'scenario': handler = new OwnScenarioAccessory(this, accessory, config); break;
            case 'contact': handler = new OwnContactAccessory(this, accessory, config); break;
            case 'energy': handler = new OwnEnergyAccessory(this, accessory, config); break;
            case 'door': handler = new OwnDoorAccessory(this, accessory, config); break;
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

    // ─── Auto-discovery ───────────────────────────────────────────────────────

    private async runAutoDiscovery(ctrl: OwnClient): Promise<void> {
        const maxAddr = (this.config as MyHomeConfig).autoDiscoverMaxAddr ?? 20;
        this.log.info('[AutoDiscover] Starting STATUS scan (addresses 1..%d)', maxAddr);

        let found: ScanFound[];
        try {
            found = await runStatusScan(ctrl, maxAddr);
        } catch (err) {
            this.log.error('[AutoDiscover] Scan failed: %s', errorMessage(err));
            return;
        }

        this.log.info('[AutoDiscover] Scan complete — %d probe(s) responded', found.length);

        const configuredAddrs = this.buildConfiguredAddrSet();

        // Clean up auto-discovered accessories that have since been added to manual config
        const promoted = this.cachedAccessories.filter(a => {
            if (!(a.context as Record<string, unknown>).autoDiscovered) return false;
            const m = a.UUID.match(/^[0-9a-f-]+$/i);
            if (!m) return false;
            // Parse who+id from the accessory context (stored during registration)
            const ctx = a.context as Record<string, unknown>;
            const who = typeof ctx.autoWho === 'number' ? ctx.autoWho : null;
            const id  = typeof ctx.autoId  === 'number' ? ctx.autoId  : null;
            if (who === null || id === null) return false;
            return configuredAddrs.get(who)?.has(id) ?? false;
        });
        if (promoted.length > 0) {
            this.log.info('[AutoDiscover] Removing %d promoted accessory(s) (now in config)', promoted.length);
            for (const a of promoted) {
                const idx = this.activeHandlers.findIndex(h => h.accessory === a);
                if (idx !== -1) { this.activeHandlers[idx].destroy(); this.activeHandlers.splice(idx, 1); }
            }
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, promoted);
            this.cachedAccessories = this.cachedAccessories.filter(a => !promoted.includes(a));
        }

        let newCount = 0;
        for (const { who, where } of found) {
            const id = parseInt(where, 10);
            if (isNaN(id) || id <= 0) continue;
            if (configuredAddrs.get(who)?.has(id)) continue;

            try {
                const isNew = this.registerAutoDiscoveredAccessory(who, id);
                if (isNew) newCount++;
            } catch (err) {
                this.log.warn('[AutoDiscover] Failed to register WHO=%d WHERE=%s: %s', who, where, errorMessage(err));
            }
        }

        if (newCount > 0) {
            this.log.warn(
                '[AutoDiscover] Registered %d new device(s) with placeholder names. ' +
                'Add them to your config.json and restart Homebridge to make them permanent.',
                newCount,
            );
        } else {
            this.log.info('[AutoDiscover] No new devices found beyond existing config.');
        }
    }

    /** Returns Map<WHO, Set<id>> for all manually configured accessories. */
    private buildConfiguredAddrSet(): Map<number, Set<number>> {
        const cfg = this.config as MyHomeConfig;
        const m = new Map<number, Set<number>>();
        const add = (who: number, items: Array<{ id: number }> | undefined) => {
            if (!items?.length) return;
            const s = m.get(who) ?? new Set<number>();
            for (const item of items) s.add(item.id);
            m.set(who, s);
        };
        add(1,  cfg.lights);
        add(2,  cfg.blinds);
        add(4,  cfg.thermostats);
        add(9,  cfg.contacts);
        add(18, cfg.energies);
        return m;
    }

    /**
     * Register a single auto-discovered device.
     * Returns true if a brand-new accessory was created, false if an existing
     * cached auto-discovered accessory was re-attached.
     */
    private registerAutoDiscoveredAccessory(who: number, id: number): boolean {
        const typeInfo = AUTO_DISCOVER_TYPES[who];
        if (!typeInfo) {
            this.log.debug('[AutoDiscover] WHO=%d not in AUTO_DISCOVER_TYPES, skipping', who);
            return false;
        }

        const uuid = this.api.hap.uuid.generate(`myhome-auto-${who}-${id}`);

        // Re-attach from cache (Homebridge restart with autoDiscover still on)
        const existing = this.cachedAccessories.find(a => a.UUID === uuid);
        if (existing) {
            this.log.info('[AutoDiscover] Restoring cached %s id=%d', typeInfo.type, id);
            existing.context.device = typeInfo.makeConfig(id);
            existing.context.type = typeInfo.type;
            (existing.context as Record<string, unknown>).autoDiscovered = true;
            (existing.context as Record<string, unknown>).autoWho = who;
            (existing.context as Record<string, unknown>).autoId  = id;
            this.api.updatePlatformAccessories([existing]);
            if (!this.activeHandlers.find(h => h.accessory === existing)) {
                this.createHandler(typeInfo.type, existing, existing.context.device as Record<string, unknown>);
            }
            return false;
        }

        const name = `${typeInfo.type.charAt(0).toUpperCase() + typeInfo.type.slice(1)} ${id}`;
        this.log.info('[AutoDiscover] Registering new %s id=%d as "%s"', typeInfo.type, id, name);
        const accessory = new this.api.platformAccessory(name, uuid);
        accessory.category = typeInfo.category ?? 1;
        const deviceConfig = typeInfo.makeConfig(id);
        accessory.context.device = deviceConfig;
        accessory.context.type = typeInfo.type;
        (accessory.context as Record<string, unknown>).autoDiscovered = true;
        (accessory.context as Record<string, unknown>).autoWho = who;
        (accessory.context as Record<string, unknown>).autoId  = id;

        this.createHandler(typeInfo.type, accessory, deviceConfig);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        return true;
    }
}
