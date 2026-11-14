// Local end-to-end check of the pipeline with real ffmpeg and two synthetic cameras (no Scrypted):
// a viewer reads the patrol's MPEG-TS while the source switches every 3 s, and the output is probed.
//   npx tsc -p tsconfig.test.json && node out-test/tools/pipeline-check.js
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { Program } from '../src/program';

const SOURCES: Record<string, string[]> = {
    // different sizes and rates on purpose: the output must not care
    a: ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15'],
    b: ['-re', '-f', 'lavfi', '-i', 'smptebars=size=640x480:rate=4'],
};
const out = process.argv[2] || 'pipeline-check.ts';
const shown: string[] = [];
let asked = 0;
const p = new Program({ width: 960, height: 540, fps: 7, bitrate: 1200 }, {
    console,
    ffmpegPath: async () => 'ffmpeg',
    input: async c => SOURCES[c],
    label: async () => undefined,
    onShowing: c => { shown.push(`${c} after ${asked ? Math.round(performance.now() - asked) : '-'} ms`); },
    onFailed: (c, r) => console.log('FAILED', c, r),
});

(async () => {
    const port = await p.listen();
    p.setSource('a');
    // the viewer: copies 14 s of the stream to a file
    const viewer = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'mpegts', '-i', `tcp://127.0.0.1:${port}`, '-t', '14', '-c', 'copy', '-y', out]);
    // like a patrol: the next camera is prepared 1.5 s ahead, then switched to; the delay to its picture is logged
    let i = 0;

    const next = () => (i + 1) % 2 ? 'b' : 'a';
    const pre = setTimeout(function prep() { p.prepare(next()); }, 1500);
    const sw = setInterval(() => {
        asked = performance.now();
        p.setSource(++i % 2 ? 'b' : 'a');
        setTimeout(() => p.prepare(next()), 1500);
    }, 3000);
    void pre;
    viewer.on('exit', code => {
        clearInterval(sw);
        p.stop();
        console.log('viewer exit', code, 'switches:', shown.join(' | '));
        const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name,profile,level,width,height,avg_frame_rate', '-of', 'compact', out]).stdout.toString();
        console.log(probe.trim());
        const pk = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', out]).stdout.toString().trim().split('\n');
        const pts = pk.map(l => parseFloat(l.split(',')[0]));
        const gaps = pts.slice(1).map((t, j) => t - pts[j]);
        const keys = pk.filter(l => l.includes('K')).map(l => parseFloat(l)).map(t => t.toFixed(2));
        console.log(`packets ${pk.length}, span ${(pts[pts.length - 1] - pts[0]).toFixed(2)} s, max gap ${Math.max(...gaps).toFixed(3)} s, min gap ${Math.min(...gaps).toFixed(3)} s`);
        console.log(`keyframes at ${keys.join(' ')}`);
        const h = spawnSync('ffmpeg', ['-v', 'trace', '-i', out, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], { maxBuffer: 512 * 1024 * 1024 }).stderr.toString();
        console.log(`SPS ${(h.match(/Sequence Parameter Set|nal_unit_type: 7\(SPS\)/g) || []).length}, PPS ${(h.match(/Picture Parameter Set|nal_unit_type: 8\(PPS\)/g) || []).length}`);
        fs.rmSync(out, { force: true });
        process.exit(0);
    });
})();
