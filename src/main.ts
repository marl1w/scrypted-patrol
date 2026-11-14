import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting } from '@scrypted/sdk';
import { randomBytes } from 'node:crypto';
import packageJson from '../package.json';
import { PatrolCamera } from './patrol';

const PREFIX = 'patrol-';

export const PATROL_INTERFACES = [
    ScryptedInterface.VideoCamera,
    ScryptedInterface.Camera,
    ScryptedInterface.MotionSensor,
    ScryptedInterface.OccupancySensor,
    ScryptedInterface.ObjectDetector,
    ScryptedInterface.Settings,
    ScryptedInterface.DeviceProvider,
];

/** Creates patrol cameras: each one shows its member cameras in turn and cuts to the one with an event. */
class PatrolPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    private patrols = new Map<string, PatrolCamera>();

    constructor(nativeId?: string) {
        super(nativeId);
        this.console.log(`Patrol ${packageJson.version} loaded`);
        // a patrol watches its members from the start, not only once something asks for it
        for (const id of sdk.deviceManager.getNativeIds())
            if (id?.startsWith(PREFIX)) this.getDevice(id).catch(e => this.console.error(`patrol ${id}`, e));
        const shutdown = () => { for (const p of this.patrols.values()) p.dispose(); };
        process.once('SIGTERM', shutdown);
        process.once('beforeExit', shutdown);
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [{ key: 'name', title: 'Name', placeholder: 'Patrol' }];
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const nativeId = `${PREFIX}${randomBytes(4).toString('hex')}`;
        await sdk.deviceManager.onDeviceDiscovered({
            nativeId,
            name: String(settings.name || 'Patrol'),
            type: ScryptedDeviceType.Camera,
            interfaces: PATROL_INTERFACES,
            info: { manufacturer: 'Patrol', model: 'Patrol', version: packageJson.version },
        });
        await this.getDevice(nativeId);
        return nativeId;
    }

    async getDevice(nativeId: string): Promise<any> {
        if (!nativeId.startsWith(PREFIX)) return;
        // a child sensor id is "<patrol>:<label>": its patrol provides it
        const [own, child] = nativeId.split(':');
        let p = this.patrols.get(own);
        if (!p) {
            p = new PatrolCamera(own);
            this.patrols.set(own, p);
        }
        return child ? p.getDevice(nativeId) : p;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        const [own, child] = nativeId.split(':');
        const p = this.patrols.get(own);
        if (child) return p?.releaseDevice(id, nativeId);
        this.patrols.delete(own);
        p?.dispose();
    }
}

export default PatrolPlugin;
