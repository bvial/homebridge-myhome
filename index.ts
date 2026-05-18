import type { API } from 'homebridge';
import { OwnPlatform } from './lib/OwnPlatform';
export { PLUGIN_NAME, PLATFORM_NAME } from './lib/constants';
import { PLUGIN_NAME, PLATFORM_NAME } from './lib/constants';

export default (api: API): void => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, OwnPlatform);
};
