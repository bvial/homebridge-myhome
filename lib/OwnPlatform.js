//@ts-check
var OwnNet = require('./OwnNet.js');
var OwnProtcol = require('./OwnProtcol.js');
var OwnAccessory = require('./OwnAccessory.js');
var { PLUGIN_NAME, PLATFORM_NAME } = require('../index.js');

class OwnPlatform {
  constructor(log, config, api) {
    const defaultConfig = {
      port: 20000,
      lights: [],
      blinds: [],
      thermostats: [],
      scenarios: [],
      contacts: [],
      energies: []
    };

    this.config = { ...defaultConfig, ...config };
    this.log = log;
    this.api = api;

    if (!this.config.host) {
      log.error('homebridge-myhome: missing required config "host" — plugin will not start');
      return;
    }

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.cachedAccessories = [];
    this.activeHandlers = [];
    this._staggerTimers = [];

    this.log.info("LegrandMyHome for MyHome Gateway at " + this.config.host + ":" + this.config.port);
    this.controller = new OwnNet.OwnClient(this.config.host, this.config.port, this.config.password, this.log);

    api.on('didFinishLaunching', () => {
      this.discoverDevices();
      this.controller.on('packet', this.onMonitor.bind(this));
      this.controller.on('monitoring', this.updateAccessoriesStatus.bind(this));
      this.controller.startMonitor();
    });

    api.on('shutdown', () => {
      for (const t of this._staggerTimers) clearTimeout(t);
      this._staggerTimers = [];
      for (const handler of this.activeHandlers) handler.destroy();
      this.activeHandlers = [];
    });
  }

  configureAccessory(accessory) {
    if (!this.cachedAccessories) return;
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  discoverDevices() {
    this.log.info("Discovering OpenWebNet devices from config");

    const allDevices = [
      ...this.config.lights.map(d => ({ ...d, type: 'light' })),
      ...this.config.blinds.map(d => ({ ...d, type: 'blind' })),
      ...this.config.thermostats.map(d => ({ ...d, type: 'thermostat' })),
      ...this.config.scenarios.map(d => ({ ...d, type: 'scenario' })),
      ...this.config.contacts.map(d => ({ ...d, type: 'contact' })),
      ...this.config.energies.map(d => ({ ...d, type: 'energy' })),
    ];

    const discoveredUUIDs = [];

    for (const device of allDevices) {
      const uuid = this.api.hap.uuid.generate('myhome-' + device.type + '-' + device.id);
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
          this.log.error('Failed to create handler for %s id=%s: %s', device.type, device.id, err.message);
        }
      } else {
        const name = device.name || device.type + '-' + device.id;
        this.log.info('Adding new accessory:', name);
        const accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.device = device;
        try {
          this.createHandler(device.type, accessory, device);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        } catch (err) {
          this.log.error('Failed to create handler for %s id=%s: %s', device.type, device.id, err.message);
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
    }
  }

  createHandler(type, accessory, config) {
    var handler;
    switch (type) {
      case 'light': handler = new OwnAccessory.OwnLightAccessory(this, accessory, config); break;
      case 'blind': handler = new OwnAccessory.OwnBlindAccessory(this, accessory, config); break;
      case 'thermostat': handler = new OwnAccessory.OwnThermostatAccessory(this, accessory, config); break;
      case 'scenario': handler = new OwnAccessory.OwnScenarioAccessory(this, accessory, config); break;
      case 'contact': handler = new OwnAccessory.OwnContactAccessory(this, accessory, config); break;
      case 'energy': handler = new OwnAccessory.OwnEnergyAccessory(this, accessory, config); break;
    }
    if (handler) this.activeHandlers.push(handler);
  }

  onMonitor(packet) {
    try {
      var info = OwnProtcol.OwnProtcol.extractPacketInfo(packet);
      switch (info.who) {
        case OwnProtcol.WHO.light:
        case OwnProtcol.WHO.automation:
        case OwnProtcol.WHO.temperature:
        case OwnProtcol.WHO.auxiliary:
        case OwnProtcol.WHO.energy:
          this.onAccessory(info.where, packet);
          break;
        case OwnProtcol.WHO.gateway:
          this.log.debug("Gateway packet", packet);
          break;
        default:
          this.log.debug("Unsupported packet", packet);
      }
    } catch (err) {
      this.log.error('Error processing packet %s: %s', packet, err.message);
    }
  }

  onAccessory(where, packet) {
    const handler = this.activeHandlers.find(h => h.checkWhere(where));
    if (handler) {
      handler.onData(packet);
    } else {
      this.log.debug("Accessory not found", where, packet);
    }
  }

  updateAccessoriesStatus() {
    this.log.info("Fetching accessories status");
    for (const t of this._staggerTimers) clearTimeout(t);
    this._staggerTimers = [];
    var delay = 0;
    for (var handler of this.activeHandlers) {
      this._staggerTimers.push(setTimeout((h) => h.updateStatus(), delay, handler));
      delay += 200;
    }
  }
}

exports.OwnPlatform = OwnPlatform;
