import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blackFrame, countdownText, displayName, patternError, decoderArgs, drawtextCheckArgs, encoderArgs, FrameAssembler, frameSize, h264Level, parseSize, safePath } from '../src/media';
import { CameraTrigger, labelKey, parseClasses, sensorLabel } from '../src/triggers';

const f = { width: 960, height: 540, fps: 7, bitrate: 1200 };

test('frame size and a black frame are yuv420p', () => {
    assert.equal(frameSize(f), 960 * 540 * 1.5);
    const b = blackFrame({ width: 4, height: 2 });
    assert.deepEqual([...b], [16, 16, 16, 16, 16, 16, 16, 16, 128, 128, 128, 128]);
});

test('the assembler cuts any chunking into whole frames, each in its own buffer', () => {
    const got: Buffer[] = [];
    const a = new FrameAssembler(4, fr => got.push(fr));
    a.push(Buffer.from([1, 2, 3]));
    a.push(Buffer.from([4, 5, 6, 7, 8, 9, 10]));
    a.push(Buffer.from([11, 12, 13]));
    assert.deepEqual(got.map(g => [...g]), [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);
    assert.notEqual(got[0], got[1]);
});

test('sizes are parsed strictly', () => {
    const fb = { width: 960, height: 540 };
    assert.deepEqual(parseSize('1280x720', fb), { width: 1280, height: 720 });
    assert.deepEqual(parseSize(' 640 × 360 ', fb), { width: 640, height: 360 });
    assert.deepEqual(parseSize('641x360', fb), fb);
    assert.deepEqual(parseSize('huge', fb), fb);
    assert.deepEqual(parseSize('8000x4000', fb), fb);
});

test('level 3.1 up to 720p30, higher above', () => {
    assert.equal(h264Level(f), '3.1');
    assert.equal(h264Level({ ...f, width: 1280, height: 720, fps: 30 }), '3.1');
    assert.equal(h264Level({ ...f, width: 1920, height: 1080, fps: 15 }), '4.0');
});

test('the encoder emits what strict players accept, from paced raw frames', () => {
    const a = encoderArgs(f).join(' ');
    for (const s of ['-f rawvideo', '-video_size 960x540', '-framerate 7', '-i pipe:0', '-profile:v main', '-level:v 3.1',
        'repeat-headers=1', '-bf 0', '-g 7', '-b:v 1200k', '-maxrate 1500k', '-f mpegts'])
        assert.ok(a.includes(s), s);
});

test('the decoder letterboxes the member stream to raw frames, label optional', () => {
    const a = decoderArgs(['-rtsp_transport', 'tcp', '-i', 'rtsp://127.0.0.1:1/x'], f);
    const vf = a[a.indexOf('-vf') + 1];
    assert.equal(vf, 'fps=7,scale=960:540:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1');
    assert.ok(a.indexOf('-i') < a.indexOf('-vf'));
    assert.deepEqual(a.slice(-5), ['-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1']);
    const l = decoderArgs(['-i', 'x'], f, { textFile: '/tmp/p/l.txt', fontFile: '/f.ttf' });
    assert.ok(l[l.indexOf('-vf') + 1].includes('drawtext=fontfile=/f.ttf:textfile=/tmp/p/l.txt:expansion=none'));
});

test('a camera triggers on any configured input', () => {
    const t = new CameraTrigger({ motion: false, occupancy: true, classes: ['Person'], detectionHoldMs: 10000 });
    assert.equal(t.on(0), false);
    t.motion = true;
    assert.equal(t.on(0), false, 'motion not configured');
    t.occupied = true;
    assert.equal(t.on(0), true);
    t.occupied = false;
    assert.equal(t.detection(['car'], 0), false);
    assert.equal(t.detection(['person'], 0), true);
    assert.equal(t.on(9999), true);
    assert.equal(t.on(10000), false);
    t.sensors.set('s1', true);
    assert.equal(t.on(20000), true);
});

test('detections are ignored when no class is configured', () => {
    const t = new CameraTrigger({ motion: true, occupancy: true, classes: [], detectionHoldMs: 10000 });
    assert.equal(t.detection(['person'], 0), false);
    assert.equal(t.on(1), false);
});

test('extra sensors are labelled without their camera name', () => {
    assert.equal(sensorLabel('Garden', 'Garden Vehicle Presence'), 'Vehicle Presence');
    assert.equal(sensorLabel('Garden', 'garden person'), 'person');
    assert.equal(sensorLabel('Garden', 'Gate contact'), 'Gate contact');
    assert.equal(sensorLabel('Garden', 'Garden'), 'Garden');
    assert.equal(labelKey('Vehicle Presence'), 'vehicle-presence');
    assert.equal(labelKey('***'), 'sensor');
    assert.deepEqual(parseClasses('person, vehicle  person,,animal'), ['person', 'vehicle', 'animal']);
});

test('countdown text, font paths and the encoder overlay', () => {
    assert.equal(countdownText('Garden', 6100), 'Garden in 7s');
    assert.equal(countdownText('Garden', 0), 'Garden in 1s');
    assert.equal(safePath('/config/overlay/DejaVuSans.ttf'), true);
    assert.equal(safePath('fonts/a.ttf'), false);
    assert.equal(safePath('/a:b.ttf'), false);
    assert.equal(safePath('/a,b.ttf'), false);
    assert.equal(safePath('/x/../etc/passwd'), false);
    const a = encoderArgs(f, { fontFile: '/f.ttf', textFile: '/tmp/c.txt' });
    const vf = a[a.indexOf('-vf') + 1];
    assert.ok(a.indexOf('-i') < a.indexOf('-vf') && a.indexOf('-vf') < a.indexOf('-c:v'));
    assert.ok(vf.startsWith('drawtext=fontfile=/f.ttf:textfile=/tmp/c.txt:reload=1:expansion=none:fontsize=14:'));
    assert.ok(vf.endsWith(':x=8:y=h-th-8'), 'bottom left');
    assert.equal(encoderArgs(f).includes('-vf'), false);
    assert.ok(drawtextCheckArgs('/f.ttf').join(' ').includes('drawtext=fontfile=/f.ttf:text=0'));
});

test('display names: regex replacement, all matches, never empty, bad patterns ignored', () => {
    assert.equal(displayName('villa_1_lateralenord', '^villa_\\d+_', ''), 'lateralenord');
    assert.equal(displayName('villa_2_cucina', '^villa_\\d+_', ''), 'cucina');
    assert.equal(displayName('villa_1_cucina', '_', ' '), 'villa 1 cucina');
    assert.equal(displayName('Garden', '', ''), 'Garden');
    assert.equal(displayName('Garden', '.*', ''), 'Garden', 'never empty');
    assert.equal(displayName('Garden', '(', ''), 'Garden');
    assert.equal(patternError('('), 'Invalid regular expression: /(/g: Unterminated group');
    assert.equal(patternError('^villa_\\d+_'), undefined);
});

test('GPU (VAAPI) arguments: off by default; on, the encoder keeps the HomeKit-safe stream and the decoder only decodes on the GPU', () => {
    const f = { width: 960, height: 540, fps: 7, bitrate: 1500 } as any;
    assert.equal(encoderArgs(f).join(' ').includes('vaapi'), false, 'software unless asked');
    const e = encoderArgs(f, { fontFile: '/f.ttf', textFile: '/tmp/c.txt' }, true).join(' ');
    assert.match(e, /^-hide_banner .* -vaapi_device \/dev\/dri\/renderD128 -f rawvideo/);
    assert.match(e, /-vf drawtext=.*,format=nv12,hwupload -c:v h264_vaapi -profile:v main -level 3\.1 -bf 0 -g 7 /);
    assert.match(e, /-b:v 1500k -maxrate 1875k -bufsize 1875k -f mpegts/);
    const d = decoderArgs(['-rtsp_transport', 'tcp', '-i', 'rtsp://127.0.0.1:1/x'], f, undefined, true).join(' ');
    assert.match(d, /-hwaccel vaapi -hwaccel_device \/dev\/dri\/renderD128 -hwaccel_output_format nv12 -rtsp_transport tcp -i /);
    assert.match(d, /scale=960:540/, 'scaling stays on the CPU (no VAAPI scaler on this iGPU)');
    assert.equal(decoderArgs(['-i', 'x'], f).join(' ').includes('hwaccel'), false);
});
