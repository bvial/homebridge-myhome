//@ts-check
var OwnProtcol = require('./OwnProtcol.js');

class OwnAccessory {
    constructor(platform, accessory, config) {
        this.log = platform.log;
        this.controller = platform.controller;
        this.Service = platform.Service;
        this.Characteristic = platform.Characteristic;
        this.accessory = accessory;

        this.name = config.name;
        this.id = config.id;

        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Manufacturer, "MyHome Assistant")
            .setCharacteristic(this.Characteristic.Model, "Accessory")
            .setCharacteristic(this.Characteristic.SerialNumber, 'MyHome-' + this.id);
    }

    updateStatus() {
        this.log.info("[" + this.id + "] Accessory updateStatus");
    }

    onData(packet) {
        this.log.debug("OwnAccessory.OnData", packet);
    }

    checkWhere(where) {
        const id = parseInt(where, 10);
        return this.id == id;
    }

    destroy() {}
}

class OwnLightAccessory extends OwnAccessory {
    constructor(platform, accessory, config) {
        if (!config.name) config.name = 'light-' + config.id;
        super(platform, accessory, config);

        this.value = false;
        this.dimmer = config.dimmer || false;
        this.brightness = 100;

        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Model, "Light");

        this.lightbulbService = this.accessory.getService(this.Service.Lightbulb)
            || this.accessory.addService(this.Service.Lightbulb);

        this.lightbulbService.getCharacteristic(this.Characteristic.On)
            .onGet(() => this.value)
            .onSet((value) => {
                this.log.info("[" + this.id + "] Setting power state to " + (value ? "on" : "off"));
                this.value = value;
                this.controller.sendCommand({
                    command: '*1*' + (value ? '1' : '0') + '*' + this.id + '##', log: this.log
                });
            });

        if (this.dimmer) {
            this.lightbulbService.getCharacteristic(this.Characteristic.Brightness)
                .onGet(() => this.brightness)
                .onSet((value) => {
                    this.log.info("[" + this.id + "] Setting brightness to " + value);
                    this.brightness = value;
                    if (value === 0) {
                        this.controller.sendCommand({ command: '*1*0*' + this.id + '##', log: this.log });
                    } else {
                        var level = Math.min(10, Math.max(2, Math.round(value / 100 * 8) + 2));
                        this.controller.sendCommand({ command: '*1*' + level + '*' + this.id + '##', log: this.log });
                    }
                });
        }
    }

    updateStatus() {
        this.log.info("[" + this.id + "] Light updateStatus");
        this.controller.sendCommand({ command: '*#1*' + this.id + '##', log: this.log });
    }

    onData(packet) {
        var extract = packet.match(/^\*1\*(\d+)\*\d+##$/);
        if (extract) {
            this.log.debug("id:%s onLight(%s)", this.id, packet);
            var level = parseInt(extract[1], 10);
            if (level === 0) {
                this.log.info("[" + this.id + "] power off");
                this.value = false;
            } else {
                this.log.info("[" + this.id + "] power on (level " + level + ")");
                this.value = true;
                if (this.dimmer && level >= 2 && level <= 10) {
                    this.brightness = Math.round((level - 2) / 8 * 100);
                    this.lightbulbService.getCharacteristic(this.Characteristic.Brightness).updateValue(this.brightness);
                }
            }
            this.lightbulbService.getCharacteristic(this.Characteristic.On).updateValue(this.value);
        } else {
            this.log.error("[%s] Light unknown packet:%s", this.id, packet);
        }
    }
}

class OwnBlindAccessory extends OwnAccessory {
    constructor(platform, accessory, config) {
        if (!config.name) config.name = 'blind-' + config.id;
        super(platform, accessory, config);

        this.time = config.time;
        this.timeSlat = config.timeSlat || 0;
        this.slatPercent = config.slatPercent || 0;

        this.state = this.Characteristic.PositionState.STOPPED;
        this.expectedState = this.Characteristic.PositionState.STOPPED;
        this.position = 0;
        this.initStartPosition = false;
        this.commandSent = false;
        this.target = 0;

        this.moveTrackingTimeout = undefined;
        this.packetTimeout = undefined;
        this.positionTimeout = undefined;

        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Model, "WindowCovering");

        this.windowCoveringService = this.accessory.getService(this.Service.WindowCovering)
            || this.accessory.addService(this.Service.WindowCovering);

        this.windowCoveringService.getCharacteristic(this.Characteristic.CurrentPosition)
            .onGet(() => this.position);

        this.windowCoveringService.getCharacteristic(this.Characteristic.TargetPosition)
            .onGet(() => this.target)
            .onSet((target) => {
                this.log.info("[" + this.id + "] Blind setting Target :" + target);
                this.stopMoveTracking();
                this.target = target;
                this.move();
            });

        this.windowCoveringService.getCharacteristic(this.Characteristic.PositionState)
            .onGet(() => this.state);

        this.windowCoveringService.getCharacteristic(this.Characteristic.HoldPosition)
            .onSet((hold) => {
                this.log.info("[" + this.id + "] Blind hold position :" + hold);
                this.stopMoveTracking();
                this.target = this.position;
                this.move();
            });
    }

    updateStatus() {
        this.log.info("[" + this.id + "] Blind updateStatus");
        if (!this.initStartPosition) {
            this.log.info("[" + this.id + "] Initialization phase of blind: reset position to 0 and send move down");
            this.controller.sendCommand({ command: '*2*2*' + this.id + '##', log: this.log });
            this.position = 0;
            this.target = 0;
            this.initStartPosition = true;
        } else {
            this.log.info("[" + this.id + "] Blind fetching State :" + this.state);
            this.controller.sendCommand({ command: '*#2*' + this.id + '##', log: this.log });
        }
    }

    startTimerCommand() {
        clearTimeout(this.packetTimeout);
        this.commandSent = true;
        this.packetTimeout = setTimeout(this.endTimerCommand.bind(this), 1000);
    }

    endTimerCommand() {
        if (this.state != this.expectedState) {
            this.state = this.expectedState;
            this.log.warn("[" + this.id + "] Blind command confirmation not received, forcing state to: " + this.expectedState);
            this.updateStatus();
        }
        this.commandSent = false;
        clearTimeout(this.packetTimeout);
    }

    commandIsPending() {
        return this.commandSent;
    }

    moveStop() {
        this.log.info("[" + this.id + "] Blind sending stop");
        this.expectedState = this.Characteristic.PositionState.STOPPED;
        this.controller.sendCommand({ command: '*2*0*' + this.id + '##', log: this.log });
        this.startTimerCommand();
    }

    moveUp() {
        this.log.info("[" + this.id + "] Blind sending move up");
        this.expectedState = this.Characteristic.PositionState.INCREASING;
        this.controller.sendCommand({ command: '*2*1*' + this.id + '##', log: this.log });
        this.startTimerCommand();
    }

    moveDown() {
        this.log.info("[" + this.id + "] Blind sending move down");
        this.expectedState = this.Characteristic.PositionState.DECREASING;
        this.controller.sendCommand({ command: '*2*2*' + this.id + '##', log: this.log });
        this.startTimerCommand();
    }

    onData(packet) {
        var extract = packet.match(/^\*2\*(\d+)\*\d+##$/);
        if (extract) {
            this.log.debug("id:%s onBlind(%s)", this.id, packet);
            var direction = extract[1];
            if (direction == '0') {
                this.state = this.Characteristic.PositionState.STOPPED;
                if (Math.abs(this.position - this.target) <= 3) {
                    this.position = this.target;
                }
            } else if (direction == '1') {
                this.state = this.Characteristic.PositionState.INCREASING;
            } else if (direction == '2') {
                this.state = this.Characteristic.PositionState.DECREASING;
            }
            this.windowCoveringService.getCharacteristic(this.Characteristic.PositionState).updateValue(this.state);
            this.log.info("[" + this.id + "] received state dir:" + direction + " position:" + this.position + " target:" + this.target);

            if (this.commandIsPending() && this.expectedState == this.state) {
                this.log.info("[" + this.id + "] expected state " + this.expectedState + " reached");
                this.endTimerCommand();
            }

            if (!this.commandIsPending()) {
                this.evaluatePosition();
            }
        } else {
            this.log.error("[%s] Blind unknown packet:%s", this.id, packet);
        }
    }

    evaluatePosition() {
        clearTimeout(this.positionTimeout);
        if (this.state == this.Characteristic.PositionState.STOPPED) {
            this.log.info("[" + this.id + "] Blind is STOPPED pos:" + this.position + " target:" + this.target);
        } else if (this.state == this.Characteristic.PositionState.INCREASING) {
            if (this.position < 100) this.position++;
            this.log.info("[" + this.id + "] Blind is moving UP pos:" + this.position + " target:" + this.target);
            if (this.position >= this.target) {
                this.moveStop();
            } else {
                this.startPositionTracking();
            }
        } else if (this.state == this.Characteristic.PositionState.DECREASING) {
            if (this.position > 0) this.position--;
            this.log.info("[" + this.id + "] Blind is moving DOWN pos:" + this.position + " target:" + this.target);
            if (this.position <= this.target) {
                this.moveStop();
            } else {
                this.startPositionTracking();
            }
        }
        this.windowCoveringService.getCharacteristic(this.Characteristic.CurrentPosition).updateValue(this.position);
    }

    /** @param {number} position */
    msPerPercent(position) {
        if (this.slatPercent > 0 && position < this.slatPercent) {
            return Math.max(50, (this.timeSlat / this.slatPercent) * 1000);
        }
        return (this.time / Math.max(1, 100 - this.slatPercent)) * 1000;
    }

    startPositionTracking() {
        clearTimeout(this.positionTimeout);
        this.positionTimeout = setTimeout(this.evaluatePosition.bind(this), this.msPerPercent(this.position));
    }

    move() {
        if (this.commandIsPending()) {
            this.log.info("[" + this.id + "] Blind command is still pending: wait for action");
        } else {
            if (this.target < this.position) {
                if (this.state == this.Characteristic.PositionState.INCREASING) {
                    this.moveStop();
                } else if (this.state != this.Characteristic.PositionState.DECREASING && Math.abs(this.target - this.position) > 2) {
                    this.moveDown();
                }
            } else if (this.target > this.position) {
                if (this.state == this.Characteristic.PositionState.DECREASING) {
                    this.moveStop();
                } else if (this.state != this.Characteristic.PositionState.INCREASING && Math.abs(this.target - this.position) > 2) {
                    this.moveUp();
                }
            } else {
                if (this.state != this.Characteristic.PositionState.STOPPED) {
                    this.moveStop();
                }
                this.log.info("[" + this.id + "] Blind position is good: stop moving " + this.position + " target:" + this.target);
                return;
            }
        }
        this.startMoveTracking();
    }

    startMoveTracking() {
        clearTimeout(this.moveTrackingTimeout);
        this.moveTrackingTimeout = setTimeout(this.move.bind(this), 500);
    }

    stopMoveTracking() {
        clearTimeout(this.moveTrackingTimeout);
        this.moveTrackingTimeout = undefined;
        this.endTimerCommand();
    }

    destroy() {
        clearTimeout(this.moveTrackingTimeout);
        clearTimeout(this.packetTimeout);
        clearTimeout(this.positionTimeout);
    }
}

class OwnThermostatAccessory extends OwnAccessory {
    constructor(platform, accessory, config) {
        if (!config.name) config.name = 'thermostat-' + config.id;
        super(platform, accessory, config);

        this.zone = config.zone;
        this.address = '#0#' + this.zone;

        this.temperature = 0;
        this.targetTemperature = 0;
        this.localOffset = 0;
        this.heatingCoolingState = this.Characteristic.CurrentHeatingCoolingState.OFF;
        this.targetHeatingCoolingState = this.Characteristic.TargetHeatingCoolingState.OFF;
        this.displayUnits = this.Characteristic.TemperatureDisplayUnits.CELSIUS;

        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Model, "Thermostat");

        this.thermostatService = this.accessory.getService(this.Service.Thermostat)
            || this.accessory.addService(this.Service.Thermostat);

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
            .onGet(() => this.heatingCoolingState);

        this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1, 3] })
            .onGet(() => this.targetHeatingCoolingState)
            .onSet((value) => {
                this.log.info("[" + this.id + "] zone[" + this.zone + "] setTargetHeatingCoolingState:" + value);
                switch (value) {
                    case this.Characteristic.TargetHeatingCoolingState.HEAT:
                        var temperature = OwnProtcol.OwnProtcol.encodeTemperature(this.targetTemperature);
                        this.log.info("[" + this.id + "] send Heat Manual at " + temperature);
                        this.controller.sendCommand({ command: '*#4*' + this.address + '*#14*' + temperature + '*1##', log: this.log });
                        break;
                    case this.Characteristic.TargetHeatingCoolingState.OFF:
                        this.controller.sendCommand({ command: '*4*103*' + this.address + '##', log: this.log });
                        this.log.info("[" + this.id + "] send STOP");
                        break;
                    case this.Characteristic.TargetHeatingCoolingState.AUTO:
                        this.controller.sendCommand({ command: '*4*3100*' + this.address + '##', log: this.log });
                        this.log.info("[" + this.id + "] send AUTO");
                        break;
                }
            });

        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature)
            .setProps({ minValue: -50, minStep: 0.1, maxValue: 50 })
            .onGet(() => this.temperature);

        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature)
            .setProps({ minValue: -50, minStep: 0.1, maxValue: 50 })
            .onGet(() => this.targetTemperature)
            .onSet((value) => {
                this.log.info("[" + this.id + "] zone[" + this.zone + "] setTargetTemperature:" + value);
                if (this.targetHeatingCoolingState != this.Characteristic.TargetHeatingCoolingState.HEAT) {
                    this.log.error("Can't change target temperature with mode (%s)", this.targetHeatingCoolingState);
                    throw new this.Characteristic.HapStatusError(-70412);
                }
                var temperature = OwnProtcol.OwnProtcol.encodeTemperature(value);
                this.controller.sendCommand({ command: '*#4*' + this.address + '*#14*' + temperature + '*1##', log: this.log });
            });

        this.thermostatService.getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
            .onGet(() => this.displayUnits)
            .onSet((value) => { this.displayUnits = value; });
    }

    updateStatus() {
        this.log.info("[" + this.id + "] Thermostat updateStatus");
        this.controller.sendCommand({ command: '*#4*' + this.address + '##', log: this.log });
        this.controller.sendCommand({ command: '*#4*' + this.id + '##', log: this.log });
    }

    checkWhere(where) {
        return this.address == where || super.checkWhere(where);
    }

    updateCharacteristicCurrentTemperature(temperature) {
        this.log.info("[" + this.id + "] update CurrentTemperature (" + temperature + ")");
        this.temperature = temperature;
        this.thermostatService.getCharacteristic(this.Characteristic.CurrentTemperature).updateValue(this.temperature);
    }

    updateCharacteristicTargetTemperature(temperature) {
        this.log.info("[" + this.id + "] update TargetTemperature (" + temperature + ")");
        this.targetTemperature = temperature;
        this.thermostatService.getCharacteristic(this.Characteristic.TargetTemperature).updateValue(this.targetTemperature);
    }

    updateCharacteristicTargetHeatingCoolingState(state) {
        this.log.info("[" + this.id + "] update TargetHeatingCoolingState (" + state + ")");
        this.targetHeatingCoolingState = state;
        this.thermostatService.getCharacteristic(this.Characteristic.TargetHeatingCoolingState).updateValue(this.targetHeatingCoolingState);
    }

    updateCharacteristicCurrentHeatingCoolingState(state) {
        this.log.info("[" + this.id + "] update CurrentHeatingCoolingState (" + state + ")");
        this.heatingCoolingState = state;
        this.thermostatService.getCharacteristic(this.Characteristic.CurrentHeatingCoolingState).updateValue(this.heatingCoolingState);
    }

    onData(packet) {
        var extract;
        if (extract = packet.match(/^\*#4\*\d+\*0\*(\d+)##$/)) {
            this.updateCharacteristicCurrentTemperature(OwnProtcol.OwnProtcol.decodeTemperature(extract[1]));
        }
        else if (extract = packet.match(/^\*#4\*\d+\*12\*(\d+)\*3##$/)) {
            var probeTemp = OwnProtcol.OwnProtcol.decodeTemperature(extract[1]);
            this.log.debug("[" + this.id + "] zone[" + this.zone + "] probe temperature with local offset (" + probeTemp + ")");
        }
        else if (extract = packet.match(/^\*#4\*\d+\*13\*(\d+)##$/)) {
            var status = 'Local ON';
            var value = extract[1];
            if (value == '00') this.localOffset = 0;
            else if (value == '01') this.localOffset = 1;
            else if (value == '11') this.localOffset = -1;
            else if (value == '02') this.localOffset = 2;
            else if (value == '12') this.localOffset = -2;
            else if (value == '03') this.localOffset = 3;
            else if (value == '13') this.localOffset = -3;
            else if (value == '4') { this.localOffset = 0; status = 'Local OFF'; }
            else if (value == '5') { this.localOffset = 0; status = 'Local protection'; }
            this.log.debug("[%s] zone[%s] local offset:%s (%s)", this.id, this.zone, this.localOffset, status);
        }
        else if (extract = packet.match(/^\*#4\*\d+\*14\*(\d+)\*3##$/)) {
            this.updateCharacteristicTargetTemperature(OwnProtcol.OwnProtcol.decodeTemperature(extract[1]));
        }
        else if (extract = packet.match(/^\*#4\*\d+\*19\*(\d)\*(\d)##$/)) {
            var CV = extract[1];
            var HV = extract[2];
            if (['1', '2'].includes(CV)) {
                this.log.debug("[" + this.id + "] zone[" + this.zone + "] cooling ON");
                this.updateCharacteristicCurrentHeatingCoolingState(this.Characteristic.CurrentHeatingCoolingState.COOL);
            } else {
                this.log.debug("[" + this.id + "] zone[" + this.zone + "] cooling OFF");
            }
            if (['1', '2'].includes(HV)) {
                this.log.debug("[" + this.id + "] zone[" + this.zone + "] heating ON");
                this.updateCharacteristicCurrentHeatingCoolingState(this.Characteristic.CurrentHeatingCoolingState.HEAT);
            } else if (this.heatingCoolingState != this.Characteristic.CurrentHeatingCoolingState.COOL) {
                this.log.debug("[" + this.id + "] zone[" + this.zone + "] heating OFF");
                this.updateCharacteristicCurrentHeatingCoolingState(this.Characteristic.CurrentHeatingCoolingState.OFF);
            }
        }
        else if (extract = packet.match(/^\*#4\*\d+#\d+\*20\*(\d+)##$/)) {
            var status = '';
            var value = extract[1];
            if (value == '0') status = 'OFF';
            else if (value == '1') status = 'ON';
            else if (value == '4') status = 'STOP';
            else status = 'not decoded:' + value;
            this.log.debug("[" + this.id + "] zone[" + this.zone + "] actuator status (" + status + ")");
            this.controller.sendCommand({ command: '*#4*' + this.id + '*19##', log: this.log });
        }
        else if (extract = packet.match(/^\*4\*(\d+)\*\d+##$/)) {
            var status = '';
            var value = extract[1];
            if (value == '0') status = 'Conditioning';
            else if (value == '1') status = 'Heating';
            else if (value == '102') status = 'Antifreeze';
            else if (value == '202') status = 'Thermal Protection';
            else if (value == '303') status = 'Generic OFF';
            else this.log.error("[%s] zone[%s] operation mode (%s)", this.id, this.zone, value);
            this.log.debug("[" + this.id + "] zone[" + this.zone + "] operation mode (" + status + ")");
        }
        else if (extract = packet.match(/^\*4\*(\d+)\*#\d#\d##$/)) {
            var valInt = parseInt(extract[1], 10);
            if (valInt == 103) {
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.OFF);
                this.log.debug("[%s] zone[%s] operation mode Heating OFF", this.id, this.zone);
            } else if (valInt == 102) {
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.OFF);
                this.log.debug("[%s] zone[%s] operation mode Anti Freeze", this.id, this.zone);
            } else if (valInt == 1101 || valInt == 1102 || valInt == 1103) {
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.AUTO);
                this.log.debug("[%s] zone[%s] operation mode Heating program", this.id, this.zone);
            } else if (valInt > 13000 && valInt < 13255) {
                var days = valInt - 13000;
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.AUTO);
                this.log.debug("[%s] zone[%s] operation mode Holiday program for %s day", this.id, this.zone, days);
            } else if (valInt == 21) {
                this.log.debug("[%s] zone[%s] Remote control enabled", this.id, this.zone);
            } else {
                this.log.error("[%s] zone[%s] unknown value (%i)", this.id, this.zone, valInt, packet);
            }
        }
        else if (extract = packet.match(/^\*4\*(\d+)#(\d+)\*#\d#\d##$/)) {
            var value = extract[1];
            if (value == '110') {
                var temp = OwnProtcol.OwnProtcol.decodeTemperature(extract[2]);
                this.log.debug("[%s] zone[%s] operation mode Manual Heating (%s)", this.id, this.zone, temp);
                this.updateCharacteristicTargetHeatingCoolingState(this.Characteristic.TargetHeatingCoolingState.HEAT);
                this.updateCharacteristicTargetTemperature(temp);
            }
        }
        else {
            this.log.error("[%s] zone[%s] unknown packet:", this.id, this.zone, packet);
        }
    }
}

class OwnScenarioAccessory extends OwnAccessory {
    constructor(platform, accessory, config) {
        if (!config.name) config.name = 'scenario-' + config.id;
        super(platform, accessory, config);

        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Model, "Scenario");

        this.switchService = this.accessory.getService(this.Service.Switch)
            || this.accessory.addService(this.Service.Switch);

        this.switchService.getCharacteristic(this.Characteristic.On)
            .onGet(() => false)
            .onSet((value) => {
                if (value) {
                    this.log.info("[" + this.id + "] Scenario activate");
                    this.controller.sendCommand({ command: '*0*' + this.id + '*0##', log: this.log });
                    setTimeout(() => {
                        this.switchService.getCharacteristic(this.Characteristic.On).updateValue(false);
                    }, 500);
                }
            });
    }

    onData(_packet) {}
    checkWhere(_where) { return false; }
}

class OwnContactAccessory extends OwnAccessory {
    constructor(platform, accessory, config) {
        if (!config.name) config.name = 'contact-' + config.id;
        super(platform, accessory, config);

        this.contactState = this.Characteristic.ContactSensorState.CONTACT_DETECTED;

        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Model, "ContactSensor");

        this.contactService = this.accessory.getService(this.Service.ContactSensor)
            || this.accessory.addService(this.Service.ContactSensor);

        this.contactService.getCharacteristic(this.Characteristic.ContactSensorState)
            .onGet(() => this.contactState);
    }

    updateStatus() {
        this.log.info("[" + this.id + "] Contact updateStatus");
        this.controller.sendCommand({ command: '*#9*' + this.id + '##', log: this.log });
    }

    onData(packet) {
        var extract = packet.match(/^\*9\*(\d+)\*\d+##$/);
        if (extract) {
            this.contactState = extract[1] === '0'
                ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
                : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
            this.log.info("[" + this.id + "] Contact state: " + this.contactState);
            this.contactService.getCharacteristic(this.Characteristic.ContactSensorState).updateValue(this.contactState);
        } else {
            this.log.error("[%s] Contact unknown packet:%s", this.id, packet);
        }
    }
}

class OwnEnergyAccessory extends OwnAccessory {
    constructor(platform, accessory, config) {
        if (!config.name) config.name = 'energy-' + config.id;
        super(platform, accessory, config);

        this.watts = 0.0001;

        this.accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Model, "EnergyMonitor");

        this.energyService = this.accessory.getService(this.Service.LightSensor)
            || this.accessory.addService(this.Service.LightSensor);

        this.energyService.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
            .onGet(() => Math.max(0.0001, this.watts));

        this._pollInterval = setInterval(() => this.updateStatus(), 30000);
    }

    destroy() {
        clearInterval(this._pollInterval);
    }

    updateStatus() {
        this.log.debug("[" + this.id + "] Energy updateStatus");
        this.controller.sendCommand({ command: '*#18*' + this.id + '*113##', log: this.log });
    }

    onData(packet) {
        var extract = packet.match(/^\*#18\*\d+\*113\*(\d+)##$/);
        if (extract) {
            this.watts = Math.max(0.0001, parseInt(extract[1], 10));
            this.log.debug("[" + this.id + "] Energy: " + this.watts + "W");
            this.energyService.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel).updateValue(this.watts);
        }
    }
}

exports.OwnLightAccessory = OwnLightAccessory;
exports.OwnBlindAccessory = OwnBlindAccessory;
exports.OwnThermostatAccessory = OwnThermostatAccessory;
exports.OwnScenarioAccessory = OwnScenarioAccessory;
exports.OwnContactAccessory = OwnContactAccessory;
exports.OwnEnergyAccessory = OwnEnergyAccessory;
