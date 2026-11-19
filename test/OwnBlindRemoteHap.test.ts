import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Bridge, Characteristic, HapStatusError, Perms, Service, uuid, type HAPConnection } from '@homebridge/hap-nodejs';
import { IdentifierCache } from '@homebridge/hap-nodejs/dist/lib/model/IdentifierCache';
import { OwnBlindAccessory, type OwnPlatformLike } from '../lib/OwnAccessory';
import { PLUGIN_NAME, PLATFORM_NAME } from '../lib/constants';
import { makeMockClient, makeMockPlatform } from './helpers';
import { PKT } from '../lib/OwnNet';

// Homebridge exposes its ESM entrypoint, not its internal cache adapter subpath.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Load the actual installed adapter without starting Homebridge.
const { PlatformAccessory } = require(join(dirname(require.resolve('homebridge')), 'platformAccessory.js')) as typeof import('homebridge/dist/platformAccessory');

interface WriteResponse { characteristics: Array<{ aid: number; iid: number; status: number }> }
interface RemoteWrites {
    handleSetCharacteristics(connection: HAPConnection, request: { characteristics: Array<{ aid: number; iid: number; value: number }> },
        callback: (error: unknown, response?: WriteResponse) => void): void;
}

describe('Blind remote HomeKit writes', () => {
    for (const restored of [false, true]) {
        for (const target of [0, 50, 100]) {
            it(`${restored ? 'restored' : 'new'} accessory accepts remote ${target === 100 ? 'open' : target === 0 ? 'close' : 'percentage with an uncertain reference'} by AID/IID`, async t => {
                const mock = makeMockPlatform();
                const network = makeMockClient(mock.log);
                const platform = { ...mock, Service, Characteristic, HapStatusError, controller: network.client } as unknown as OwnPlatformLike;
                const identifiers = new IdentifierCache('CC:22:3D:E3:CE:30');
                const bridge = new Bridge('Test bridge', uuid.generate(t.name + '-bridge'));
                const original = new PlatformAccessory('Blind', uuid.generate(t.name));
                original._associatedPlugin = PLUGIN_NAME;
                original._associatedPlatform = PLATFORM_NAME;
                original.context.blindPosition = target === 100 ? 0 : 100;
                if (target === 50) original.context.blindState = {
                    position: 100, confidence: 'unknown', updatedAt: Date.now(), wasMoving: false,
                };
                // The legacy accessory had the same standard WindowCovering service.
                // Include its cached HAP descriptor, not just its device context.
                const originalCovering = original.addService(Service.WindowCovering);
                originalCovering.setPrimaryService(true);
                originalCovering.getCharacteristic(Characteristic.StatusFault);
                originalCovering.getCharacteristic(Characteristic.ConfiguredName).updateValue('Blind');
                originalCovering.getCharacteristic(Characteristic.ObstructionDetected);
                originalCovering.getCharacteristic(Characteristic.HoldPosition);
                bridge.addBridgedAccessory(original._associatedHAPAccessory);
                bridge._assignIDs(identifiers);
                const aid = original._associatedHAPAccessory.aid!;
                const iid = originalCovering.getCharacteristic(Characteristic.TargetPosition).iid!;

                let accessory = original;
                if (restored) {
                    const cached = JSON.parse(JSON.stringify(PlatformAccessory.serialize(original)));
                    bridge.removeBridgedAccessory(original._associatedHAPAccessory);
                    accessory = PlatformAccessory.deserialize(cached);
                    bridge.addBridgedAccessory(accessory._associatedHAPAccessory);
                }
                const handler = new OwnBlindAccessory(platform, accessory, { id: 2, time: 20, calibrateOnStart: false });
                t.after(() => { handler.destroy(); network.client.destroy(); bridge.removeBridgedAccessory(accessory._associatedHAPAccessory); });
                handler.setOnline(true);
                bridge._assignIDs(identifiers);
                const characteristic = accessory.getService(Service.WindowCovering)!.getCharacteristic(Characteristic.TargetPosition);
                assert.equal(accessory._associatedHAPAccessory.aid, aid);
                assert.equal(characteristic.iid, iid);
                assert.ok(characteristic.props.perms.includes(Perms.PAIRED_WRITE));
                assert.equal(characteristic.props.minValue, 0);
                assert.equal(characteristic.props.maxValue, 100);

                // Exercise the real request router: permissions and client value
                // validation run before onSet, unlike a direct UI setValue call.
                const response = new Promise<WriteResponse>((resolve, reject) => {
                    (bridge as unknown as RemoteWrites).handleSetCharacteristics({ username: 'test-controller' } as HAPConnection,
                        { characteristics: [{ aid, iid, value: target }] },
                        (error, result) => error ? reject(new Error(`HAP write failed: ${JSON.stringify(error)}`)) : resolve(result!));
                });
                assert.deepEqual(network.sent, [`*2*${target === 100 ? 1 : 2}*2##`]);
                network.connections[0].onData(PKT.ACK);
                assert.deepEqual(await response, { characteristics: [{ aid, iid, status: 0, value: undefined }] });
                assert.equal(handler.snapshot().targetPosition, target);
            });
        }
    }
});
