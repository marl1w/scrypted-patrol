// The running output of one patrol: a local MPEG-TS server fed by one encoder, and the decoder of the camera on
// screen. Node only (child_process, net); the Scrypted side is passed in, so this module has no SDK dependency.
import { ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import { blackFrame, decoderArgs, encoderArgs, FrameAssembler, frameSize, OutputFormat, TextOverlay } from './media';

export interface ProgramDeps {
    console: Console;
    ffmpegPath(): Promise<string>;
    /** ffmpeg input arguments (ending with -i <url>) for a member camera's stream */
    input(camera: string): Promise<string[]>;
    /** the label to draw on a camera's frames, if any */
    label(camera: string): Promise<{ fontFile?: string; textFile: string } | undefined>;
    /** the camera now on screen changed (undefined: black) */
    onShowing(camera: string | undefined): void;
    /** a camera's stream did not start or stopped delivering frames */
    onFailed(camera: string, reason: string): void;
}

/** time allowed for a decoder's first frame, and longest silence of a running one */
const FIRST_FRAME_MS = 15000;
const STALL_MS = 10000;
/** the encoder keeps running this long after the last viewer left (a reconnect costs a cold start) */
const LINGER_MS = 30000;
/** a viewer that falls this far behind is dropped (it reconnects) instead of buffering without end */
const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;

class Decoder {
    proc?: ChildProcess;
    firstFrameAt = 0;
    lastFrameAt = 0;
    startedAt = Date.now();
    stopped = false;
    /** the newest frame, kept while preloading so a switch can show it at once */
    latest?: Buffer;

    constructor(readonly camera: string) { }

    stop() {
        this.stopped = true;
        try { this.proc?.kill('SIGKILL'); } catch { /* gone */ }
    }
}

export class Program {
    private server?: net.Server;
    private port?: number;
    private clients = new Set<net.Socket>();
    private encoder?: ChildProcess;
    private encoderBusy = false;
    private pacer?: NodeJS.Timeout;
    private watchdog?: NodeJS.Timeout;
    private linger?: NodeJS.Timeout;
    private frame: Buffer;
    private current?: Decoder;
    private pending?: Decoder;
    /** the camera expected next, decoding ahead of its switch but not shown */
    private standby?: Decoder;
    private desired?: string;
    private stopped = false;
    private overlay?: TextOverlay;
    showing?: string;

    constructor(private format: OutputFormat, private deps: ProgramDeps) {
        this.frame = blackFrame(format);
    }

    get running() {
        return !!this.encoder;
    }

    get viewers() {
        return this.clients.size;
    }

    get output() {
        return this.format;
    }

    /** the local port the MPEG-TS stream is served on (started once, kept for the plugin's life) */
    async listen(): Promise<number> {
        if (this.port) return this.port;
        if (!this.server) {
            this.server = net.createServer(s => this.accept(s));
            this.server.on('error', e => this.deps.console.error('patrol: stream server', e));
        }
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(0, '127.0.0.1', () => { this.server!.off('error', reject); resolve(); });
        });
        this.port = (this.server.address() as net.AddressInfo).port;
        return this.port;
    }

    /** a new output format: viewers are dropped and reconnect to the new stream */
    setFormat(f: OutputFormat) {
        if (f.width === this.format.width && f.height === this.format.height && f.fps === this.format.fps && f.bitrate === this.format.bitrate) return;
        this.format = f;
        this.frame = blackFrame(f);
        this.stopEncoder('output format changed');
    }

    /** text drawn by the encoder (the countdown), or none: a change restarts the encoder, viewers reconnect */
    setOverlay(o: TextOverlay | undefined) {
        if (JSON.stringify(o) === JSON.stringify(this.overlay)) return;
        this.overlay = o;
        this.stopEncoder('text overlay changed');
    }

    /** the camera to show; switches once the new camera's first frame is there, and retries a failed one */
    setSource(camera: string | undefined) {
        this.desired = camera;
        if (!this.running) {
            this.setShowing(camera);
            return;
        }
        if (!camera) {
            this.standby?.stop();
            this.standby = undefined;
            this.pending?.stop();
            this.pending = undefined;
            this.current?.stop();
            this.current = undefined;
            this.frame = blackFrame(this.format);
            this.setShowing(undefined);
            return;
        }
        if (this.standby?.camera === camera) {
            const s = this.standby;
            this.standby = undefined;
            this.pending?.stop();
            this.pending = s;
            // preloaded: its frames are already there, the switch is immediate
            if (s.firstFrameAt) this.promote(s);
            return;
        }
        if (this.pending?.camera === camera) return;
        if (this.current?.camera === camera && !this.pending) return;
        if (this.current?.camera === camera) {
            // back to the camera still on screen before the pending one arrived
            this.pending?.stop();
            this.pending = undefined;
            return;
        }
        this.pending?.stop();
        this.pending = this.startDecoder(camera);
    }

    /** starts decoding the camera expected next, so its switch is immediate; undefined stops the preload */
    prepare(camera: string | undefined) {
        if (!this.running) return;
        if (!camera || camera === this.current?.camera || camera === this.pending?.camera) {
            if (this.standby && this.standby.camera !== camera) {
                this.standby.stop();
                this.standby = undefined;
            }
            return;
        }
        if (this.standby?.camera === camera) return;
        this.standby?.stop();
        this.standby = this.startDecoder(camera);
    }

    /** decoder settings changed (source stream, label): the camera on screen is decoded again */
    restartSource() {
        if (!this.running) return;
        const want = this.desired ?? this.current?.camera;
        this.pending?.stop();
        this.pending = undefined;
        if (want) this.pending = this.startDecoder(want);
    }

    stop() {
        this.stopped = true;
        this.stopEncoder('stopped');
        this.server?.close();
        this.server = undefined;
        this.port = undefined;
    }

    private setShowing(camera: string | undefined) {
        if (this.showing === camera) return;
        this.showing = camera;
        this.deps.onShowing(camera);
    }

    private accept(s: net.Socket) {
        if (this.stopped) {
            s.destroy();
            return;
        }
        s.setNoDelay(true);
        s.on('error', () => { /* closed below */ });
        s.on('close', () => {
            this.clients.delete(s);
            if (!this.clients.size) {
                clearTimeout(this.linger);
                this.linger = setTimeout(() => { if (!this.clients.size) this.stopEncoder('no viewers'); }, LINGER_MS);
            }
        });
        s.on('data', () => { /* nothing is expected from a viewer */ });
        this.clients.add(s);
        clearTimeout(this.linger);
        if (!this.encoder) this.startEncoder().catch(e => {
            this.deps.console.error('patrol: encoder did not start', e);
            for (const c of this.clients) c.destroy();
        });
    }

    private async startEncoder() {
        if (this.encoder) return;
        const ffmpeg = await this.deps.ffmpegPath();
        if (this.encoder || !this.clients.size) return;
        const f = this.format;
        const proc = spawn(ffmpeg, encoderArgs(f, this.overlay), { stdio: ['pipe', 'pipe', 'pipe'] });
        this.encoder = proc;
        this.encoderBusy = false;
        this.deps.console.log(`patrol: encoder started, ${f.width}x${f.height} @ ${f.fps} fps, ${f.bitrate} kbit/s`);
        proc.stdout!.on('data', (chunk: Buffer) => {
            for (const c of this.clients) {
                if (c.writableLength > MAX_CLIENT_BACKLOG) c.destroy();
                else c.write(chunk);
            }
        });
        proc.stderr!.on('data', (d: Buffer) => this.deps.console.warn(`patrol: encoder: ${d.toString().trim()}`));
        proc.stdin!.on('error', () => { /* exit handled below */ });
        proc.stdin!.on('drain', () => { this.encoderBusy = false; });
        proc.on('exit', (code, signal) => {
            if (this.encoder !== proc) return;
            this.deps.console.warn(`patrol: encoder exited (${signal ?? code})`);
            this.encoder = undefined;
            this.teardown();
            // viewers reconnect and start a fresh encoder
            for (const c of this.clients) c.destroy();
        });

        const size = frameSize(f);
        this.pacer = setInterval(() => {
            if (!this.encoder || this.encoderBusy || this.frame.length !== size) return;
            if (!this.encoder.stdin!.write(this.frame)) this.encoderBusy = true;
        }, 1000 / f.fps);
        this.watchdog = setInterval(() => this.checkDecoders(), 1000);
        // the camera that should be on screen starts now
        const want = this.desired;
        this.setShowing(undefined);
        this.desired = undefined;
        this.setSource(want);
    }

    private stopEncoder(reason: string) {
        clearTimeout(this.linger);
        const proc = this.encoder;
        if (!proc) return;
        this.deps.console.log(`patrol: encoder stopped (${reason})`);
        this.encoder = undefined;
        this.teardown();
        try { proc.stdin!.end(); } catch { /* gone */ }
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
        for (const c of this.clients) c.destroy();
    }

    private teardown() {
        clearInterval(this.pacer);
        clearInterval(this.watchdog);
        this.pacer = this.watchdog = undefined;
        this.pending?.stop();
        this.current?.stop();
        this.standby?.stop();
        this.pending = this.current = this.standby = undefined;
        this.frame = blackFrame(this.format);
    }

    private startDecoder(camera: string): Decoder {
        const d = new Decoder(camera);
        const f = this.format;
        (async () => {
            const [ffmpeg, input, label] = await Promise.all([this.deps.ffmpegPath(), this.deps.input(camera), this.deps.label(camera)]);
            if (d.stopped) return;
            const proc = spawn(ffmpeg, decoderArgs(input, f, label), { stdio: ['ignore', 'pipe', 'pipe'] });
            d.proc = proc;
            const frames = new FrameAssembler(frameSize(f), frame => {
                if (d.stopped) return;
                d.lastFrameAt = Date.now();
                if (!d.firstFrameAt) {
                    d.firstFrameAt = d.lastFrameAt;
                    this.promote(d);
                }
                d.latest = frame;
                if (this.current === d) this.frame = frame;
            });
            proc.stdout!.on('data', (chunk: Buffer) => frames.push(chunk));
            let err = '';
            proc.stderr!.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-500); });
            proc.on('exit', (code, signal) => {
                if (d.stopped) return;
                this.fail(d, `decoder exited (${signal ?? code})${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`);
            });
        })().catch(e => { if (!d.stopped) this.fail(d, (e as Error).message); });
        return d;
    }

    /** the pending decoder delivered its first frame: it takes the screen */
    private promote(d: Decoder) {
        if (this.pending !== d) return;
        this.current?.stop();
        this.current = d;
        this.pending = undefined;
        if (d.latest) this.frame = d.latest;
        this.setShowing(d.camera);
    }

    private fail(d: Decoder, reason: string) {
        d.stop();
        if (this.pending === d) this.pending = undefined;
        if (this.standby === d) this.standby = undefined;
        if (this.current === d) this.current = undefined; // the last frame stays on screen until the next camera
        this.deps.onFailed(d.camera, reason);
    }

    private checkDecoders() {
        const now = Date.now();
        for (const d of [this.pending, this.current, this.standby]) {
            if (!d || d.stopped) continue;
            if (!d.firstFrameAt && now - d.startedAt > FIRST_FRAME_MS) this.fail(d, `no frame within ${FIRST_FRAME_MS / 1000} s`);
            else if (d.firstFrameAt && now - d.lastFrameAt > STALL_MS) this.fail(d, `no frame for ${STALL_MS / 1000} s`);
        }
        // a camera that failed and is still wanted (the only one, say) is tried again by the next setSource
        if (this.desired && !this.pending && this.current?.camera !== this.desired) {
            const want = this.desired;
            this.desired = undefined;
            this.setSource(want);
        }
    }
}
