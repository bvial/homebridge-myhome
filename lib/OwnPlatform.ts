import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from './constants';
import { OwnClient } from './OwnNet';
import { OwnProtcol, WHO } from './OwnProtcol';
import {
    OwnLightAccessory,
    OwnBlindAccessory,
    OwnThermostatAccessory,
    OwnScenarioAccessory,
    OwnContactAccessory,
    OwnEnergyAccessory,
    OwnPlatformLike,
    LightConfig,
    BlindConfig,
    ThermostatConfig,
    ScenarioConfig,
    ContactConfig,
    EnergyConfig,
} from './OwnAccessory';

interface MyHomeConfig extends PlatformConfig {
    host?: string;
    port?: number;
    password?: string;
    maxConcurrent?: number;
    debug?: boolean;
    lights?: LightConfig[];
    blinds?: BlindConfig[];
    thermostats?: ThermostatConfig[];
    scenarios?: ScenarioConfig[];
    contacts?: ContactConfig[];
    energies?: EnergyConfig[];
}

type AnyAccessory = OwnLightAccessory | OwnBlindAccessory | OwnThermostatAccessory
    | OwnScenarioAccessory | OwnContactAccessory | OwnEnergyAccessory;

function recommendedConcurrency(model: string | null): number {
    if (model === null) return 2;
    const upper = model.toUpperCase();
    if (upper.includes('F454') || upper.includes('F455') || upper.includes('454') || upper.includes('455')) return 4;
    if (upper.includes('F452') || upper.includes('MH200') || upper.includes('452')) return 3;
    return 2;
}

export class OwnPlatform implements DynamicPlatformPlugin {
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly HapStatusError: new (status: number) => Error;
    cachedAccessories: PlatformAccessory[];
    activeHandlers: AnyAccessory[];
    controller: OwnClient | undefined;
    private staggerTimers: ReturnType<typeof setTimeout>[];
    private readonly config: Required<Omit<MyHomeConfig, 'host'>> & { host?: string };

    constructor(
        public readonly log: Logging,
        config: PlatformConfig,
        public readonly api: API,
    ) {
        const defaultConfig: Omit<MyHomeConfig, keyof PlatformConfig> = {
            port: 20000,
            lights: [],
            blinds: [],
            thermostats: [],
            scenarios: [],
            contacts: [],
            energies: [],
        };

        this.config = { ...defaultConfig, ...config } as Required<Omit<MyHomeConfig, 'host'>> & { host?: string };

        if (this.config.debug) {
            (this.log as unknown as Record<string, unknown>)['debug'] = this.log.info.bind(this.log);
            this.log.info('homebridge-myhome: debug logging enabled');
        }

        this.Service = api.hap.Service as typeof Service;
        this.Characteristic = api.hap.Characteristic as typeof Characteristic;
        this.HapStatusError = (api.hap as unknown as { HapStatusError: new (status: number) => Error }).HapStatusError;
        this.cachedAccessories = [];
        this.activeHandlers = [];
        this.staggerTimers = [];

        if (!this.config.host) {
            log.error('homebridge-myhome: missing required config "host" — plugin will not start');
            return;
        }

        this.log.info(`LegrandMyHome for MyHome Gateway at ${this.config.host}:${this.config.port}`);
        this.controller = new OwnClient(
            this.config.host,
            this.config.port ?? 20000,
            this.config.password ?? '',
            this.log,
        );
        api.on('didFinishLaunching', () => {
            const ctrl = this.controller;
            if (!ctrl) return;
            ctrl.detectGatewayModel((model) => {
                if (this.config.maxConcurrent !== undefined) {
                    ctrl.maxConcurrent = this.config.maxConcurrent;
                    this.log.info(`maxConcurrent set to ${ctrl.maxConcurrent} (from config)`);
                } else {
                    ctrl.maxConcurrent = recommendedConcurrency(model);
                    this.log.info(`maxConcurrent auto-set to ${ctrl.maxConcurrent}${model ? ` (gateway: ${model})` : ' (gateway unknown)'}`);
                }
                this.discoverDevices();
                ctrl.on('packet', this.onMonitor.bind(this));
                ctrl.on('monitoring', this.updateAccessoriesStatus.bind(this));
                ctrl.startMonitor();
            });
        });

        api.on('shutdown', () => {
            for (const t of this.staggerTimers) clearTimeout(t);
            this.staggerTimers = [];
            for (const handler of this.activeHandlers) handler.destroy();
            this.activeHandlers = [];
        });
    }

    configureAccessory(accessory: PlatformAccessory): void {
        if (this.controller === undefined) return;
        this.log.info('Restoring cached accessory:', accessory.displayName);
        this.cachedAccessories.push(accessory);
    }

    discoverDevices(): void {
        this.log.info('Discovering OpenWebNet devices from config');

        const allDevices = [
            ...(this.config.lights ?? []).map((d: LightConfig) => ({ ...d, type: 'light' as const })),
            ...(this.config.blinds ?? []).map((d: BlindConfig) => ({ ...d, type: 'blind' as const })),
            ...(this.config.thermostats ?? []).map((d: ThermostatConfig) => ({ ...d, type: 'thermostat' as const })),
            ...(this.config.scenarios ?? []).map((d: ScenarioConfig) => ({ ...d, type: 'scenario' as const })),
            ...(this.config.contacts ?? []).map((d: ContactConfig) => ({ ...d, type: 'contact' as const })),
            ...(this.config.energies ?? []).map((d: EnergyConfig) => ({ ...d, type: 'energy' as const })),
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
                this.api.updatePlatformAccessories([existingAccessory]);
                try {
                    this.createHandler(device.type, existingAccessory, device);
                } catch (err) {
                    this.log.error('Failed to create handler for %s id=%s: %s', device.type, device.id, (err as Error).message);
                }
            } else {
                const name = device.name ?? `${device.type}-${device.id}`;
                this.log.info('Adding new accessory:', name);
                const accessory = new this.api.platformAccessory(name, uuid);
                accessory.context.device = device;
                try {
                    this.createHandler(device.type, accessory, device);
                    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                } catch (err) {
                    this.log.error('Failed to create handler for %s id=%s: %s', device.type, device.id, (err as Error).message);
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
        const platform = this as unknown as OwnPlatformLike;
        let handler: AnyAccessory | undefined;
        switch (type) {
            case 'light': handler = new OwnLightAccessory(platform, accessory, config as unknown as LightConfig); break;
            case 'blind': handler = new OwnBlindAccessory(platform, accessory, config as unknown as BlindConfig); break;
            case 'thermostat': handler = new OwnThermostatAccessory(platform, accessory, config as unknown as ThermostatConfig); break;
            case 'scenario': handler = new OwnScenarioAccessory(platform, accessory, config as unknown as ScenarioConfig); break;
            case 'contact': handler = new OwnContactAccessory(platform, accessory, config as unknown as ContactConfig); break;
            case 'energy': handler = new OwnEnergyAccessory(platform, accessory, config as unknown as EnergyConfig); break;
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
                    this.onAccessory(info.where, packet);
                    break;
                case WHO.gateway:
                    this.log.debug('Gateway packet', packet);
                    break;
                default:
                    this.log.debug('Unsupported packet', packet);
            }
        } catch (err) {
            this.log.error('Error processing packet %s: %s', packet, (err as Error).message);
        }
    }

    onAccessory(where: string | null, packet: string): void {
        if (!where) return;
        const handler = this.activeHandlers.find(h => h.checkWhere(where));
        if (handler) {
            handler.onData(packet);
        } else {
            this.log.debug('Accessory not found', where, packet);
        }
    }

    updateAccessoriesStatus(): void {
        this.log.info('Fetching accessories status');
        for (const t of this.staggerTimers) clearTimeout(t);
        this.staggerTimers = [];
        let delay = 0;
        for (const handler of this.activeHandlers) {
            this.staggerTimers.push(setTimeout((h: AnyAccessory) => h.updateStatus(), delay, handler));
            delay += 200;
        }
    }
}
