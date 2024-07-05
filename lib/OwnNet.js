//@ts-check
var net = require('net');
var events = require('events');

const STATE = {
    UNCONNECTED: 'UNCONNECTED',
    CONNECTING: 'CONNECTING',
    LOGGING_IN: 'LOGGING_IN',
    CONNECTED: 'CONNECTED'
};

const SCAN_STATE = {
    INIT: 0,
    RECEIVE: 1
}


const MODE = {
    MONITOR: 'MONITOR',
    COMMAND: 'COMMAND',
    CONFIG: 'CONFIG'
};

const DIR = {
    IN: 'IN',
    OUT: 'OUT'
}

const PKT = {
    ACK: '*#*1##',
    NACK: '*#*0##'
}

const CMD = {
    START_CONFIG: '*99*0##',
    START_COMMAND: '*99*9##',
    START_MONITOR: '*99*1##',
    SCAN: '*1001*12*0##',
    SCAN_ALL: '*#1001*0*13##',
    SCAN_UNCONFIGURED: '*#1001*0*13#0##',
    START_CONFIGURED: '*#1001*0*13#1##'
}

var id_count = 0;

function calcPass(pass, nonce) {
    var flag = true; var num1 = 0x0; var num2 = 0x0;
    var password = parseInt(pass, 10);
    for (var c in nonce) {
        c = nonce[c];
        if (c != '0') {
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

class OwnConnection extends events.EventEmitter {

    constructor(_host, _port, _password, _mode, _log) {
        super();
        id_count = id_count + 1;
        this.id = id_count.toString();

        this.host = _host;
        this.port = parseInt(_port, 10);;
        this.password = _password;
        this.conn = null;

        this.state = STATE.UNCONNECTED;
        this.mode = _mode;
        this.log = _log;
    }

    connect() {
        if (this.conn) {
            this.log.debug('conn:%s end old socket',this.id);
            this.conn.end();
        }
        /* TODO: catch EADDRNOTAVAIL - device not present */
        this.log.debug('conn:%s open socket host: %s, port:%s ',this.id,this.host,this.port) ;
        this.conn = net.connect({ host: this.host, port: this.port });
        this.conn.on('data', this.onData.bind(this));
        this.conn.on('error', (_error) => {
            this.log.error(_error);
            this.state = STATE.UNCONNECTED;
            this.emit('close');
        });

        this.conn.on('close', (_error) => {
            this.state = STATE.UNCONNECTED;
            this.emit('close');
            this.end();    
        });

    }

    setTimeout( time ){
        if (this.conn ) {                
            this.conn.setTimeout(time)
            this.conn.on('timeout', () => {
                this.log.debug('conn:%s socket timeout',this.id);
                this.end();
            });
        }    
    }

    end() {
        if (this.conn) {
            this.log.debug('conn:%s end',this.id);
            this.conn.end();
            this.conn = null;
        }
    }

    logPacket(direction, packet) {
        if (this.log != null){
            this.log.debug('conn:%s mode:%s dir:%s data:%s',this.id, this.mode, direction, packet);    
        }
    };

    sendPacket(packet) {
        this.logPacket(DIR.OUT, packet);
        if (this.conn)
            this.conn.write(packet);
    };

    onData(data) {
        var sdata = data.toString();

        /* handle the fact that more that one packet can come in at the same time */
        while (sdata.length > 0) {
            var m = sdata.match(/(\*.+?##)(.*)/);
            /* first packet is m[1], rest is m[2] */
            var packet = m[1];
            var sdata = m[2];

            this.logPacket(DIR.IN, packet);
            switch (this.state) {
                case STATE.UNCONNECTED:
                    if (packet == PKT.ACK) {
                        this.emit('connecting');
                        this.state = STATE.CONNECTING;
                        this.log.debug('conn:%s new connection',this.id);
                        switch (this.mode) {
                            case MODE.MONITOR:
                                this.sendPacket(CMD.START_MONITOR);
                                break;
                            case MODE.COMMAND:
                                this.sendPacket(CMD.START_COMMAND);
                                break;
                            case MODE.CONFIG:
                                this.sendPacket(CMD.START_CONFIG);
                                break;
                        }
                    }
                    break;
                case STATE.CONNECTING:
                    if (packet == PKT.ACK) {
                        this.emit('connected');
                        this.state = STATE.CONNECTED;
                        this.log.debug('conn:%s start unauthenticated connection',this.id);
                    } else {
                        /* probably need to login */
                        /* login nonce is of the form *#<numbers>## */
                        m = packet.match(/\*#(\d+)##/);
                        if (m === null) {
                            /* no match ? */
                            this.log.error("conn:%s Unable to recognize packet '%s'",this.id, packet);
                        } else {
                            this.emit('logging-in');
                            /* nonce is first captured string from regexp */
                            this.log.debug('conn:%s send password',this.id);
                            var p = calcPass(this.password, m[1]);
                            this.state = STATE.LOGGING_IN;
                            this.sendPacket('*#' + p + '##');
                        }
                    }
                    break;
                case STATE.LOGGING_IN:
                    if (packet == PKT.ACK) {
                        this.emit('connected');
                        this.state = STATE.CONNECTED;
                        this.log.debug('conn:%s start authenticated connection',this.id);
                    } else {
                        this.log.error('conn:%s Got unexpected packet in loggin phase',this.id);
                    }
                    break;

                case STATE.CONNECTED:
                    this.emit('packet', packet);
                    break;
            }
        }
    }
}

class OwnMonitor extends events.EventEmitter {
    constructor(_OwnClient) {
        super();
        this.client = _OwnClient;
        this.connection = null;
        this.checkTimeout = null;
        this.nbCheck = 0;
        this.reconnectSeconds = 20; //2*60;/*2 min*/
    }

    connect() {
        this.client.log.info("Start monitoring MyHome server");
        if (this.connection != null) {
            this.connection.end();
        }
        this.connection = this.client.newConnection( MODE.MONITOR);
        this.connection.on('connected', function () {
            this.emit('connected');
        }.bind(this));
        this.connection.on('close', function () {
            this.emit('close');
        }.bind(this));
        this.connection.on('packet', function (data) {
            this.resetAutoConnectTimeout();
            this.resetCheck();
            this.emit('packet', data);
        }.bind(this));
        this.connection.connect();
        this.resetCheck();
        this.resetAutoConnectTimeout();
    };

    checkMonitor() {
        this.client.sendCommand({ command: '*#13**15##', stopon: PKT.ACK });
    }
    
    resetCheck() {
        this.nbCheck = 0;
    }

    resetAutoConnectTimeout() {
        if (this.checkTimeout != null) 
            clearTimeout(this.checkTimeout);
        this.checkTimeout = setTimeout(this.restartConnection.bind(this), this.reconnectSeconds * 1000);
    }
    
    restartConnection() {
        if (this.nbCheck < 3 ) {
          this.nbCheck++;
          this.checkMonitor();
        }
        else {
          this.client.log.error("Monitor connexion is dead, restart it");
          this.connect();
        }
        this.resetAutoConnectTimeout();
    }
}
    
class OwnClient extends events.EventEmitter {
    constructor(_host, _port, _password, _log) {
        super();
        this.host = _host;
        this.password = _password;
        this.port = _port;
        this.monitor = null;
        this.log = _log;
    }

    newConnection( _mode, _log) {
        return new OwnConnection(this.host, this.port, this.password, _mode, _log ||this.log);
    }

    /* the params object contains the following :
	 * params.command : the command to be sent
	 * params.stopon  : packets to stop on 
	 * params.packet  : callback for each packet
	 * params.done	  : callback for when we're at the end
	 */
    sendCommand(params) {
        var commandconn = this.newConnection(MODE.COMMAND,params.log);
        commandconn.on('connected', function () {
            commandconn.sendPacket(params.command);
        });
        commandconn.on('packet', function (packet) {
            function done(packet, index) {
                commandconn.end();
                if (params.done)
                    params.done(packet, index);
            }

            /* check if data is in stopon variable */
            if (params.stopon !== undefined) {
                if (Array.isArray(params.stopon)) {
                    var i = params.stopon.indexOf(packet);
                    if (i != -1) return done(packet, i);
                } else if (packet == params.stopon)
                    return done(packet, 0);
            }
            else if (packet ==  PKT.ACK ){
                return done(packet, 0);
            }
            if (params.packet)
                params.packet(packet);
        });
        commandconn.connect();
        commandconn.setTimeout(10000);
    }

    startMonitor() {
        this.monitor = new OwnMonitor(this);
        this.monitor.on('connected', function () {
            this.emit('monitoring');
        }.bind(this));
        this.monitor.on('packet', function (data) {
            this.emit('packet', data);
        }.bind(this));
        this.monitor.on('close', function () {
            this.emit('unmonitoring');
        }.bind(this));
        this.monitor.connect();
    };


    _scanSystem(cmd, callback) {
        // state variable
        var SCAN_INIT = 0;
        var SCAN_RECEIVE = 1;
        var state = SCAN_STATE.INIT;
        var macs = [];
        var confconn = this.newConnection( MODE.CONFIG);
        confconn.on('connected', function () {
            confconn.sendPacket(CMD.SCAN);
        });
        confconn.on('packet', function (pkt) {
            switch (state) {
                case SCAN_STATE.INIT:
                    if (pkt == PKT.ACK) {
                        state = SCAN_STATE.RECEIVE;
                        confconn.log.debug('Start scan');
                        confconn.sendPacket(cmd);
                    } else {
                        this.log.erro('unexpected packet expected \'' + PKT.ACK + '\' got\'' + pkt + '\'');
                    }
                    break;
                case SCAN_STATE.RECEIVE:
                    if (pkt == PKT.ACK) {
                        confconn.end();
                        if (callback)
                            return callback(macs);
                    } else {
                        var m = pkt.match(/\*#(\d+)\*(\d+)\*(\d+)\*(\d+)##/);
                        macs.push(parseInt(m[4], 10));
                    }
                    break;
            }
        }.bind(this));
        confconn.connect();
    };

    scanSystem(callback) {
        this._scanSystem(CMD.SCAN_ALL, callback);
    }
    scanUnconfigured(callback) {
        this._scanSystem(CMD.SCAN_UNCONFIGURED, callback);
    }
    scanConfigured(callback) {
        this._scanSystem(CMD.START_CONFIGURED, callback);
    }
}

exports.MODE = MODE;
exports.CMD = CMD;
exports.PKT=PKT;
exports.OwnConnection = OwnConnection;
exports.OwnClient = OwnClient;