import type { API } from 'homebridge';
import { OwnPlatform } from './lib/OwnPlatform';
import { PLUGIN_NAME, PLATFORM_NAME } from './lib/constants';

export { PLUGIN_NAME, PLATFORM_NAME };

export default (api: API): void => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, OwnPlatform);
};
