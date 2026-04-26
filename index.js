'use strict';
const OwnPlatform = require('./lib/OwnPlatform');

const PLUGIN_NAME = 'homebridge-myhome';
const PLATFORM_NAME = 'MyHome';

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, OwnPlatform.OwnPlatform);
};

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLATFORM_NAME = PLATFORM_NAME;
