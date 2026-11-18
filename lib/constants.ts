export const PLUGIN_NAME = 'homebridge-myhome-unik';
export const PLATFORM_NAME = 'MyHome';

let version = '0.0.0';
try {
    // Source execution (e.g. ts-node / direct from lib/)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    version = (require('../package.json') as { version: string }).version;
} catch {
    try {
        // Compiled execution (from dist/lib/)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        version = (require('../../package.json') as { version: string }).version;
    } catch {
        // Fallback if package.json cannot be located
    }
}
export const PLUGIN_VERSION: string = version;
