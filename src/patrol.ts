import sdk, {
    BinarySensor, Camera, DeviceProvider, EventListenerRegister, FFmpegInput, MediaObject, MediaStreamDestination, MotionSensor,
    ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OccupancySensor, PictureOptions, RequestMediaStreamOptions,
    RequestPictureOptions, ResponseMediaStreamOptions, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface,
    ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera,
} from '@scrypted/sdk';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Director, DirectorConfig, View } from './director';
import { countdownText, displayName, drawtextCheckArgs, OutputFormat, parseSize, patternError, safePath } from './media';
import { Program } from './program';
import { CameraTrigger, labelKey, parseClasses, sensorLabel, TriggerConfig } from './triggers';

const TICK_MS = 250;
/** the camera the rotation shows next starts decoding this long before its switch */
const PRELOAD_MS = 4000;
const SIZES = ['640x360', '960x540', '1280x720', '1920x1080'];
const DESTINATIONS: MediaStreamDestination[] = ['low-resolution', 'medium-resolution', 'local', 'remote'];

type Member = ScryptedDevice & VideoCamera & Camera & MotionSensor & OccupancySensor;

/** A child sensor of the patrol: on while the camera on screen for an event has a sensor with the same label on. */
export class PatrolSensor extends ScryptedDeviceBase implements OccupancySensor {
    constructor(nativeId: string) { super(nativeId); }
}

export class PatrolCamera extends ScryptedDeviceBase implements VideoCamera, Camera, MotionSensor, OccupancySensor, ObjectDetector, Settings, DeviceProvider {
    private director: Director;
    private program: Program;
    private triggers = new Map<string, CameraTrigger>();
    /** extra sensor id -> { camera, label } */
    private sensorMap = new Map<string, { camera: string; label: string }>();
    private children = new Map<string, PatrolSensor>();
    private listeners: EventListenerRegister[] = [];
    private timer?: NodeJS.Timeout;
    private view: View = { reason: 'idle' };
    private lastFailure = '';
    private labelDir = path.join(os.tmpdir(), 'scrypted-patrol');
    /** whether this ffmpeg draws text with the configured font, per font (checked once each) */
    private textChecks = new Map<string, Promise<boolean>>();
    private textStatus = 'not used';
    /** the countdown file while the encoder draws it, and what it holds */
    private countdownFile?: string;
    private countdownShown = '';

    constructor(nativeId: string) {
        super(nativeId);
        this.director = new Director(this.directorConfig());
        this.program = new Program(this.outputFormat(), {
            console: this.console,
            ffmpegPath: () => sdk.mediaManager.getFFmpegPath(),
            input: camera => this.memberInput(camera),
            label: camera => this.labelFor(camera),
            onShowing: camera => {
                this.director.confirmShown(camera, performance.now());
                this.console.log(`patrol: on screen: ${camera ? this.nameOf(camera) : 'nothing'}`);
                this.publish();
            },
            onFailed: (camera, reason) => {
                this.lastFailure = `${this.nameOf(camera)}: ${reason}`;
                this.console.warn(`patrol: ${this.lastFailure}`);
                this.director.setUnavailable(camera, performance.now());
            },
        });
        this.motionDetected = false;
        this.occupied = false;
        this.configure();
        this.timer = setInterval(() => this.tick(), TICK_MS);
    }

    // ---- configuration ---------------------------------------------------------------------------

    private json<T>(key: string, fallback: T): T {
        try {
            const v = this.storage.getItem(key);
            return v ? JSON.parse(v) as T : fallback;
        }
        catch {
            return fallback;
        }
    }

    private num(key: string, fallback: number, min: number, max: number) {
        const v = parseFloat(this.storage.getItem(key) ?? '');
        return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
    }

    private bool(key: string, fallback: boolean) {
        const v = this.storage.getItem(key);
        return v === null || v === undefined || v === '' ? fallback : v === 'true';
    }

    private members(): string[] {
        return this.json<string[]>('members', []).filter(id => id && id !== this.id && !!sdk.systemManager.getDeviceById(id));
    }

    private sensorsOf(camera: string): string[] {
        return this.json<string[]>(`sensors:${camera}`, []).filter(id => !!sdk.systemManager.getDeviceById(id));
    }

    private directorConfig(): DirectorConfig {
        return {
            members: this.members(),
            rotateMs: this.num('rotate', 10, 0, 3600) * 1000,
            minEventMs: this.num('minEvent', 8, 0, 3600) * 1000,
            maxEventMs: this.num('maxEvent', 120, 5, 86400) * 1000,
            holdMs: this.num('hold', 5, 0, 600) * 1000,
            unavailableMs: 60000,
            rearmMs: this.num('rearm', 30, 0, 3600) * 1000,
        };
    }

    private triggerConfig(): TriggerConfig {
        return {
            motion: this.bool('useMotion', true),
            occupancy: this.bool('useOccupancy', true),
            classes: parseClasses(this.storage.getItem('classes') ?? ''),
            detectionHoldMs: this.num('detectionHold', 10, 1, 600) * 1000,
        };
    }

    private outputFormat(): OutputFormat {
        const { width, height } = parseSize(this.storage.getItem('size') ?? '', { width: 960, height: 540 });
        return { width, height, fps: this.num('fps', 7, 1, 30), bitrate: this.num('bitrate', 1200, 100, 20000) };
    }

    private destination(): MediaStreamDestination {
        const d = this.storage.getItem('destination') as MediaStreamDestination;
        return DESTINATIONS.includes(d) ? d : 'low-resolution';
    }

    /** re-reads every setting and re-subscribes to the members and their sensors */
    private configure() {
        const sm = sdk.systemManager;
        for (const l of this.listeners) l.removeListener();
        this.listeners = [];
        this.director.configure(this.directorConfig());
        this.program.setFormat(this.outputFormat());
        this.updateOverlay().catch(e => this.console.error('patrol: text overlay', e));

        const tc = this.triggerConfig();
        const members = this.members();
        const old = this.triggers;
        this.triggers = new Map();
        this.sensorMap.clear();
        for (const id of members) {
            const dev = sm.getDeviceById<Member>(id);
            const t = old.get(id) ?? new CameraTrigger(tc);
            t.configure(tc);
            t.sensors.clear();
            this.triggers.set(id, t);
            const ifs = dev.interfaces || [];
            if (ifs.includes(ScryptedInterface.MotionSensor)) {
                t.motion = !!dev.motionDetected;
                this.listeners.push(sm.listenDevice(id, ScryptedInterface.MotionSensor, (_s, _d, data) => { t.motion = !!data; }));
            }
            if (ifs.includes(ScryptedInterface.OccupancySensor)) {
                t.occupied = !!dev.occupied;
                this.listeners.push(sm.listenDevice(id, ScryptedInterface.OccupancySensor, (_s, _d, data) => { t.occupied = !!data; this.publish(); }));
            }
            if (ifs.includes(ScryptedInterface.ObjectDetector)) {
                this.listeners.push(sm.listenDevice(id, ScryptedInterface.ObjectDetector, (_s, _d, data: ObjectsDetected) => this.onDetection(id, t, data)));
            }
            for (const sid of this.sensorsOf(id)) {
                const s = sm.getDeviceById<ScryptedDevice & MotionSensor & OccupancySensor & BinarySensor>(sid);
                const label = sensorLabel(dev.name || '', s.name || sid);
                this.sensorMap.set(sid, { camera: id, label });
                const sifs = s.interfaces || [];
                const read = () => !!((sifs.includes(ScryptedInterface.OccupancySensor) && s.occupied)
                    || (sifs.includes(ScryptedInterface.MotionSensor) && s.motionDetected)
                    || (sifs.includes(ScryptedInterface.BinarySensor) && s.binaryState));
                t.sensors.set(sid, read());
                for (const iface of [ScryptedInterface.OccupancySensor, ScryptedInterface.MotionSensor, ScryptedInterface.BinarySensor]) {
                    if (sifs.includes(iface))
                        this.listeners.push(sm.listenDevice(sid, iface, () => { t.sensors.set(sid, read()); this.publish(); }));
                }
            }
        }
        this.syncChildren().catch(e => this.console.error('patrol: child sensors', e));
        this.console.log(`patrol: ${members.length} camera(s): ${members.map(m => this.nameOf(m)).join(', ') || 'none'}`);
    }

    private nameOf(id: string) {
        return sdk.systemManager.getDeviceById(id)?.name || id;
    }

    /** the name drawn on screen: the camera name through the configured regex replacement */
    private shownName(id: string) {
        return displayName(this.nameOf(id), this.storage.getItem('namePattern') || '', this.storage.getItem('nameReplace') || '');
    }

    // ---- child sensors ---------------------------------------------------------------------------

    private labels() {
        return [...new Set([...this.sensorMap.values()].map(s => s.label))];
    }

    private childNativeId(label: string) {
        return `${this.nativeId}:${labelKey(label)}`;
    }

    private async syncChildren() {
        const devices = this.labels().map(label => ({
            nativeId: this.childNativeId(label),
            providerNativeId: this.nativeId,
            name: `${this.name} ${label}`,
            type: ScryptedDeviceType.Sensor,
            interfaces: [ScryptedInterface.OccupancySensor],
            info: { manufacturer: 'Patrol', model: 'Patrol sensor' },
        }));
        await sdk.deviceManager.onDevicesChanged({ providerNativeId: this.nativeId, devices });
    }

    async getDevice(nativeId: string): Promise<any> {
        let c = this.children.get(nativeId);
        if (!c) this.children.set(nativeId, c = new PatrolSensor(nativeId));
        return c;
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        this.children.delete(nativeId);
    }

    // ---- the loop --------------------------------------------------------------------------------

    private onDetection(camera: string, t: CameraTrigger, data: ObjectsDetected) {
        const classes = (data?.detections || []).map(d => String(d?.className || '')).filter(Boolean);
        t.detection(classes, performance.now());
        // the event camera's detections are the patrol's own, once it is on screen
        if (this.eventCamera() === camera)
            sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, data);
    }

    private tick() {
        const now = performance.now();
        for (const [id, t] of this.triggers) this.director.setTrigger(id, t.on(now), now);
        this.view = this.director.tick(now);
        this.program.setSource(this.view.camera);
        const up = this.director.upcoming(now);
        this.program.prepare(up && up.inMs <= PRELOAD_MS ? up.camera : undefined);
        this.writeCountdown(now);
        this.publish();
    }

    // ---- text on screen --------------------------------------------------------------------------

    private fontFile() {
        return (this.storage.getItem('fontFile') || '').trim();
    }

    /** whether ffmpeg can draw text with the configured font: one frame, once per font */
    private textWorks(): Promise<boolean> {
        const font = this.fontFile();
        if (font && !safePath(font)) {
            this.textStatus = `font path not usable in a filter: ${font}`;
            return Promise.resolve(false);
        }
        let check = this.textChecks.get(font);
        if (!check) {
            check = (async () => {
                const ffmpeg = await sdk.mediaManager.getFFmpegPath();
                return new Promise<boolean>(resolve => {
                    const proc = spawn(ffmpeg, drawtextCheckArgs(font || undefined), { stdio: ['ignore', 'ignore', 'pipe'] });
                    let err = '';
                    proc.stderr!.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-300); });
                    const timer = setTimeout(() => proc.kill('SIGKILL'), 10000);
                    proc.on('error', () => resolve(false));
                    proc.on('exit', code => {
                        clearTimeout(timer);
                        if (code !== 0) this.console.warn(`patrol: ffmpeg cannot draw text${font ? ` with ${font}` : ' without a font file'}: ${err.trim().split('\n').pop() || code}`);
                        resolve(code === 0);
                    });
                });
            })();
            this.textChecks.set(font, check);
        }
        return check.then(ok => {
            this.textStatus = ok ? `ok${font ? ` (${font})` : ' (fontconfig)'}` : `unavailable${font ? ` with ${font}` : ': set a font file'}`;
            return ok;
        });
    }

    /** the countdown is drawn by the encoder: switched on only once its file exists and text works */
    private async updateOverlay() {
        if (!this.bool('countdown', false)) {
            this.countdownFile = undefined;
            this.program.setOverlay(undefined);
            return;
        }
        if (!await this.textWorks()) {
            this.countdownFile = undefined;
            this.program.setOverlay(undefined);
            return;
        }
        await fs.promises.mkdir(this.labelDir, { recursive: true });
        const textFile = path.join(this.labelDir, `${createHash('sha1').update(`${this.id}:countdown`).digest('hex').slice(0, 16)}.txt`);
        this.countdownShown = '';
        this.countdownFile = textFile;
        this.writeCountdown(performance.now());
        const font = this.fontFile();
        this.program.setOverlay({ fontFile: font || undefined, textFile });
    }

    /** rewritten only when the text changes (once a second), atomically: a frame never reads half a file */
    private writeCountdown(now: number) {
        if (!this.countdownFile) return;
        const up = this.director.upcoming(now);
        // nothing while a switch is still on its way (the picture is not the one counted from yet);
        // an empty file fails drawtext, so a space
        const switching = this.program.running && this.program.showing !== this.view.camera;
        const text = up && !switching ? countdownText(this.shownName(up.camera), up.inMs) : ' ';
        if (text === this.countdownShown) return;
        this.countdownShown = text;
        try {
            const tmp = `${this.countdownFile}.tmp`;
            fs.writeFileSync(tmp, text);
            fs.renameSync(tmp, this.countdownFile);
        }
        catch (e) {
            this.console.warn('patrol: countdown file', (e as Error).message);
        }
    }

    /** the camera on screen because of an event (not a hold), once the switch to it is complete */
    private eventCamera(): string | undefined {
        if (this.view.reason !== 'event' || !this.view.camera) return;
        return this.program.showing === this.view.camera ? this.view.camera : undefined;
    }

    /** motion, occupancy and the child sensors follow the event camera on screen; all off otherwise */
    private publish() {
        const cam = this.eventCamera();
        const t = cam ? this.triggers.get(cam) : undefined;
        const motion = !!cam;
        const occupied = !!t?.occupied;
        if (this.motionDetected !== motion) this.motionDetected = motion;
        if (this.occupied !== occupied) this.occupied = occupied;
        for (const label of this.labels()) {
            const on = !!t && [...this.sensorMap].some(([sid, s]) => s.camera === cam && s.label === label && t.sensors.get(sid));
            const child = this.children.get(this.childNativeId(label));
            if (child && child.occupied !== on) child.occupied = on;
        }
    }

    // ---- media -----------------------------------------------------------------------------------

    private async memberInput(camera: string): Promise<string[]> {
        const dev = sdk.systemManager.getDeviceById<VideoCamera>(camera);
        const mo = await dev.getVideoStream({ destination: this.destination() } as RequestMediaStreamOptions);
        const ff = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(mo, ScryptedMimeTypes.FFmpegInput);
        if (ff?.inputArguments?.length) return [...ff.inputArguments];
        if (ff?.url) return ['-i', ff.url];
        throw new Error('no stream');
    }

    private async labelFor(camera: string) {
        if (!this.bool('label', false) || !await this.textWorks()) return undefined;
        await fs.promises.mkdir(this.labelDir, { recursive: true });
        const textFile = path.join(this.labelDir, `${createHash('sha1').update(`${this.id}:${camera}`).digest('hex').slice(0, 16)}.txt`);
        await fs.promises.writeFile(textFile, this.shownName(camera).replace(/[\r\n]+/g, ' '));
        const fontFile = this.fontFile();
        return { fontFile: fontFile || undefined, textFile };
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const f = this.outputFormat();
        return [{
            id: 'patrol', name: 'Patrol', container: 'mpegts', tool: 'ffmpeg',
            video: { codec: 'h264', width: f.width, height: f.height, fps: f.fps },
            audio: null as any,
        } as ResponseMediaStreamOptions];
    }

    async getVideoStream(_options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const port = await this.program.listen();
        const [opts] = await this.getVideoStreamOptions();
        const url = `tcp://127.0.0.1:${port}`;
        const ffmpegInput: FFmpegInput = {
            url,
            container: 'mpegts',
            inputArguments: ['-f', 'mpegts', '-i', url],
            mediaStreamOptions: opts,
        };
        return sdk.mediaManager.createFFmpegMediaObject(ffmpegInput);
    }

    /** the camera on screen takes the picture */
    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const cam = this.program.showing ?? this.view.camera;
        if (!cam) throw new Error('no camera on screen');
        return sdk.systemManager.getDeviceById<Camera>(cam).takePicture(options);
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        return [];
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        return { classes: this.triggerConfig().classes };
    }

    async getDetectionInput(): Promise<MediaObject> {
        throw new Error('detection input not available');
    }

    // ---- settings --------------------------------------------------------------------------------

    async getSettings(): Promise<Setting[]> {
        const members = this.members();
        const tc = this.triggerConfig();
        const dc = this.directorConfig();
        const f = this.outputFormat();
        const age = this.view.camera && this.view.reason !== 'rotation' ? Math.round(this.director.eventAge(this.view.camera, performance.now()) / 1000) : 0;
        const status = this.view.camera
            ? `${this.nameOf(this.view.camera)} (${this.view.reason}${age ? `, event for ${age} s` : ''})${this.program.showing && this.program.showing !== this.view.camera ? `, switching from ${this.nameOf(this.program.showing)}` : ''}`
            : 'nothing';
        const settings: Setting[] = [
            {
                group: 'Cameras', key: 'members', title: 'Cameras', type: 'device', multiple: true,
                deviceFilter: `interfaces.includes('${ScryptedInterface.VideoCamera}') && id !== '${this.id}'`,
                description: 'The cameras of this patrol, in rotation order.',
                value: members,
            },
            {
                group: 'Triggers', key: 'useMotion', title: 'Camera motion', type: 'boolean', value: tc.motion,
                description: "A member's own motion sensor starts an event.",
            },
            {
                group: 'Triggers', key: 'useOccupancy', title: 'Camera occupancy', type: 'boolean', value: tc.occupancy,
                description: "A member's own occupancy sensor starts an event.",
            },
            {
                group: 'Triggers', key: 'classes', title: 'Detection classes', value: tc.classes.join(', '),
                placeholder: 'person, vehicle',
                description: "Object detection classes of a member that start an event (comma separated). Empty: detections are not used.",
            },
            {
                group: 'Triggers', key: 'detectionHold', title: 'Detection hold (s)', type: 'number', value: tc.detectionHoldMs / 1000,
                description: 'How long one matching detection counts as an event.',
            },
        ];
        for (const id of members) {
            settings.push({
                group: 'Triggers', subgroup: this.nameOf(id), key: `sensors:${id}`, title: `Extra sensors: ${this.nameOf(id)}`,
                type: 'device', multiple: true,
                deviceFilter: `interfaces.includes('${ScryptedInterface.OccupancySensor}') || interfaces.includes('${ScryptedInterface.MotionSensor}') || interfaces.includes('${ScryptedInterface.BinarySensor}')`,
                description: 'Sensors that start an event on this camera. Each also gets a sensor on the patrol, named after it without the camera\'s name, on while this camera is on screen for an event and the sensor is on.',
                value: this.sensorsOf(id),
            });
        }
        settings.push(
            { group: 'Timing', key: 'rotate', title: 'Rotation (s)', type: 'number', value: dc.rotateMs / 1000, description: 'Time on each camera while nothing happens. 0: no rotation.' },
            { group: 'Timing', key: 'minEvent', title: 'Minimum event time (s)', type: 'number', value: dc.minEventMs / 1000, description: 'An event camera keeps the screen at least this long before a newer event elsewhere takes over.' },
            { group: 'Timing', key: 'maxEvent', title: 'Maximum event time (s)', type: 'number', value: dc.maxEventMs / 1000, description: 'One event keeps the screen at most this long; the camera must go quiet and trigger again (a parked car does not hold the screen forever).' },
            { group: 'Timing', key: 'hold', title: 'Hold after event (s)', type: 'number', value: dc.holdMs / 1000, description: 'The screen stays on the event camera this long after its event ends.' },
            { group: 'Timing', key: 'rearm', title: 'Re-arm after (s)', type: 'number', value: dc.rearmMs / 1000, description: 'A trigger that comes back within this time after going off continues the same event (same start, same maximum).' },
            { group: 'Output', key: 'size', title: 'Size', choices: SIZES, combobox: true, value: `${f.width}x${f.height}`, description: 'Every camera is scaled into this frame (letterboxed).' },
            { group: 'Output', key: 'fps', title: 'Frame rate', type: 'number', value: f.fps },
            { group: 'Output', key: 'bitrate', title: 'Bitrate (kbit/s)', type: 'number', value: f.bitrate },
            { group: 'Output', key: 'destination', title: 'Source stream', choices: DESTINATIONS, value: this.destination(), description: "Which of each member's streams is decoded (as its stream roles map it). Low resolution keeps the decode cheap." },
            { group: 'Output', key: 'label', title: 'Camera name on screen', type: 'boolean', value: this.bool('label', false), description: 'Top left.' },
            { group: 'Output', key: 'countdown', title: 'Countdown to the next camera', type: 'boolean', value: this.bool('countdown', false), description: 'Bottom left, small, while rotating: "Next: <camera> in 7s".' },
            { group: 'Output', key: 'namePattern', title: 'Name pattern', value: this.storage.getItem('namePattern') || '', placeholder: '^villa_\\d+_', description: `Regular expression applied to the camera names shown on screen (all matches).${patternError(this.storage.getItem('namePattern') || '') ? ` Invalid: ${patternError(this.storage.getItem('namePattern') || '')}` : ''}` },
            { group: 'Output', key: 'nameReplace', title: 'Name replacement', value: this.storage.getItem('nameReplace') || '', placeholder: '(empty: remove)', description: 'What each match becomes; $1 and so on refer to groups.' },
            { group: 'Output', key: 'fontFile', title: 'Font file', value: this.fontFile(), placeholder: '/path/to/font.ttf', description: 'For the text on screen; needed when this ffmpeg has no fontconfig. Checked once with a one-frame run: when text does not work it is left out, the stream is unaffected.' },
            { group: 'Status', key: 'status', title: 'On screen', readonly: true, value: status },
            { group: 'Status', key: 'output', title: 'Output', readonly: true, value: `${this.program.running ? 'encoding' : 'idle'}, ${this.program.viewers} viewer(s)` },
            { group: 'Status', key: 'failure', title: 'Last stream failure', readonly: true, value: this.lastFailure || 'none' },
            { group: 'Status', key: 'text', title: 'Text on screen', readonly: true, value: this.textStatus },
        );
        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'members' || key.startsWith('sensors:')) {
            const ids = (Array.isArray(value) ? value : value ? [value] : []).map(String).filter(Boolean);
            this.storage.setItem(key, JSON.stringify([...new Set(ids)]));
        }
        else if (key === 'classes') {
            this.storage.setItem(key, parseClasses(String(value ?? '')).join(', '));
        }
        else if (['status', 'output', 'failure', 'text'].includes(key)) {
            return;
        }
        else {
            this.storage.setItem(key, String(value ?? ''));
        }
        this.configure();
        if (['label', 'fontFile', 'destination', 'namePattern', 'nameReplace'].includes(key)) this.program.restartSource();
        if (key === 'namePattern' || key === 'nameReplace') this.countdownShown = '';
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    dispose() {
        clearInterval(this.timer);
        for (const l of this.listeners) l.removeListener();
        this.listeners = [];
        this.program.stop();
    }
}
