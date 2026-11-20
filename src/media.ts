// Pure media helpers (no Scrypted runtime): raw frame handling and the ffmpeg command lines.
//
// The pipeline: one decoder per shown camera turns that camera's stream into raw yuv420p frames at the output
// size; the plugin paces the newest frame into ONE long-running encoder at a fixed rate. The encoder never sees
// a camera switch as anything but a scene change, so the output is a single continuous H.264 stream with one
// resolution, one frame rate and steady timestamps, whatever the member cameras send.

export interface OutputFormat {
    width: number;
    height: number;
    fps: number;
    /** kbit/s */
    bitrate: number;
}

export const frameSize = (f: Pick<OutputFormat, 'width' | 'height'>) => f.width * f.height * 3 / 2;

/** a black yuv420p frame (limited range: Y 16, chroma 128) */
export function blackFrame(f: Pick<OutputFormat, 'width' | 'height'>): Buffer {
    const y = f.width * f.height;
    const b = Buffer.alloc(frameSize(f), 128);
    b.fill(16, 0, y);
    return b;
}

/** Cuts a byte stream into whole frames of a fixed size. */
export class FrameAssembler {
    private buf: Buffer;
    private used = 0;

    constructor(readonly size: number, private onFrame: (frame: Buffer) => void) {
        this.buf = Buffer.alloc(size);
    }

    push(chunk: Buffer) {
        let off = 0;
        while (off < chunk.length) {
            const n = Math.min(this.size - this.used, chunk.length - off);
            chunk.copy(this.buf, this.used, off, off + n);
            this.used += n;
            off += n;
            if (this.used === this.size) {
                this.onFrame(this.buf);
                // the consumer keeps the frame it was given, so fill a fresh buffer next
                this.buf = Buffer.alloc(this.size);
                this.used = 0;
            }
        }
    }
}

/** Parses "WIDTHxHEIGHT" (even numbers, 160..3840). */
export function parseSize(s: string | undefined, fallback: { width: number; height: number }) {
    const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(s || '');
    if (!m) return fallback;
    const width = +m[1], height = +m[2];
    if (width < 160 || height < 90 || width > 3840 || height > 2160 || width % 2 || height % 2) return fallback;
    return { width, height };
}

/**
 * H.264 level for the output: the lowest of 3.1 / 4.0 / 4.1 / 4.2 whose macroblock rate fits. 3.1 is the floor
 * because players that announce what they accept (HomeKit among them) commonly list 3.1 as their lowest level.
 */
export function h264Level(f: OutputFormat) {
    const mbs = Math.ceil(f.width / 16) * Math.ceil(f.height / 16);
    const rate = mbs * f.fps;
    if (mbs <= 3600 && rate <= 108000) return '3.1';
    if (mbs <= 8192 && rate <= 245760) return '4.0';
    if (mbs <= 8704 && rate <= 522240) return '4.2';
    return '5.1';
}

export interface TextOverlay {
    fontFile?: string;
    textFile: string;
}

/**
 * A path that can go into a filter graph as is: no quoting or escaping levels to get wrong. Anything else
 * (a ':' or ',' in it, say) is refused, and the text is left out.
 */
export const safePath = (p: string | undefined) => !!p && /^\/[\w./ -]+$/.test(p) && !p.includes('..');

const fontOption = (fontFile?: string) => fontFile ? `fontfile=${fontFile}:` : '';

/** "Garden in 7s" (rounded up, never 0 while waiting) */
export const countdownText = (camera: string, inMs: number) => `${camera.replace(/[\r\n]+/g, ' ')} in ${Math.max(1, Math.ceil(inMs / 1000))}s`;

/** A display name: the camera name with an optional regex replacement applied (all matches). */
export function displayName(name: string, pattern: string | undefined, replacement: string | undefined): string {
    if (!pattern) return name;
    try {
        const out = name.replace(new RegExp(pattern, 'g'), replacement ?? '').trim();
        return out || name;
    }
    catch {
        return name;
    }
}

/** undefined when the pattern is a valid regex (or empty), else the error */
export function patternError(pattern: string | undefined): string | undefined {
    if (!pattern) return;
    try { new RegExp(pattern, 'g'); return; } catch (e) { return (e as Error).message; }
}

/** a one-frame run that tells whether this ffmpeg can draw text with this font */
export function drawtextCheckArgs(fontFile?: string): string[] {
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1',
        '-vf', `drawtext=${fontOption(fontFile)}text=0`, '-frames:v', '1', '-f', 'null', '-'];
}

/**
 * The decoder: the member's stream (its own ffmpeg input arguments, as its VideoCamera handed them out) to raw
 * frames, letterboxed into the output size at the output rate. `labelFile` draws its text top left.
 */
/** the VAAPI render node (Intel iGPU on the box); the same flags Coral Guard decodes with */
export const VAAPI_DEVICE = '/dev/dri/renderD128';
/** stderr of an ffmpeg that failed because of VAAPI: that path falls back to software for good */
export const HW_ERROR_RE = /vaapi|va_|hwaccel|hwupload|hwdownload|AVHWFramesContext|libva|surface/i;

export function decoderArgs(input: string[], f: OutputFormat, label?: { fontFile?: string; textFile: string }, hw = false): string[] {
    const vf = [
        `fps=${f.fps}`,
        `scale=${f.width}:${f.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        `pad=${f.width}:${f.height}:(ow-iw)/2:(oh-ih)/2`,
        'setsar=1',
    ];
    if (label)
        vf.push(`drawtext=${fontOption(label.fontFile)}textfile=${label.textFile}:expansion=none:fontsize=${Math.max(12, Math.round(f.height / 30))}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4:x=8:y=8`);
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-fflags', '+nobuffer+discardcorrupt',
        // GPU decode into system memory (nv12): scaling stays on the CPU, the box's iGPU has no VAAPI scaler
        ...(hw ? ['-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEVICE, '-hwaccel_output_format', 'nv12'] : []),
        ...input,
        '-an', '-sn', '-dn',
        '-vf', vf.join(','),
        '-pix_fmt', 'yuv420p',
        '-f', 'rawvideo', 'pipe:1',
    ];
}

/**
 * The encoder: paced raw frames to H.264 in MPEG-TS. Main profile, level 3.1 or up, no B-frames, SPS/PPS repeated
 * on every keyframe and a keyframe every second: what strict live players (HomeKit) accept as is, so whatever
 * serves this stream onwards can copy it instead of encoding it again. x264 also cuts a keyframe on the scene
 * change of a camera switch.
 */
export function encoderArgs(f: OutputFormat, overlay?: TextOverlay, hw = false): string[] {
    const k = Math.round(f.bitrate);
    // the countdown: a text file the plugin rewrites (atomically) once a second, re-read on every frame
    const text = overlay ? [`drawtext=${fontOption(overlay.fontFile)}textfile=${overlay.textFile}:reload=1:expansion=none:fontsize=${Math.max(10, Math.round(f.height / 40))}:fontcolor=white@0.9:box=1:boxcolor=black@0.4:boxborderw=3:x=8:y=h-th-8`] : [];
    const rate = ['-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.25)}k`, '-bufsize', `${Math.round(k * 1.25)}k`];
    // the same stream either way: Main profile, the level, no B-frames, a keyframe every second with SPS/PPS in band
    // (h264_vaapi writes them before every IDR; each I-frame is an IDR with its default idr_interval 0)
    const codec = hw
        ? ['-vf', [...text, 'format=nv12', 'hwupload'].join(','), '-c:v', 'h264_vaapi', '-profile:v', 'main', '-level', h264Level(f),
            '-bf', '0', '-g', String(f.fps), '-rc_mode', 'VBR', ...rate]
        : [...(text.length ? ['-vf', text[0]] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
            '-profile:v', 'main', '-level:v', h264Level(f), '-pix_fmt', 'yuv420p',
            '-x264-params', 'repeat-headers=1', '-bf', '0', '-g', String(f.fps), ...rate];
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        ...(hw ? ['-vaapi_device', VAAPI_DEVICE] : []),
        '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-video_size', `${f.width}x${f.height}`, '-framerate', String(f.fps),
        '-i', 'pipe:0',
        ...codec,
        '-f', 'mpegts', '-flush_packets', '1', 'pipe:1',
    ];
}
