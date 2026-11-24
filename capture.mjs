#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 60;
const TOTAL_FRAMES = 900; // 15.00 seconds exact
const DURATION = TOTAL_FRAMES / FPS;
const MAX_MP4_BYTES = 40 * 1024 * 1024;

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Could not find Chrome/Chromium binary');
}

function startStaticServer(rootDir) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const fullPath = path.resolve(rootDir, rel);
      if (!fullPath.startsWith(rootDir) || !fs.existsSync(fullPath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(fullPath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method && this.listeners.has(msg.method)) {
        for (const fn of this.listeners.get(msg.method)) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function launchChrome() {
  const chromeBin = findChrome();
  const port = 9300 + Math.floor(Math.random() * 900);
  const profileDir = path.join(PROJECT_DIR, `.tmp_chrome_${process.pid}`);
  fs.mkdirSync(profileDir, { recursive: true });

  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderrBuf = '';
  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  let wsUrl = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }

  if (!wsUrl) {
    proc.kill('SIGKILL');
    fs.rmSync(profileDir, { recursive: true, force: true });
    throw new Error('Failed to attach to headless Chrome:\n' + stderrBuf.slice(-1000));
  }

  const cdp = new CDPClient(wsUrl);
  await cdp.connect();
  return { proc, cdp, profileDir };
}

async function evalJs(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error('Page JS exception: ' + JSON.stringify(res.exceptionDetails));
  }
  return res.result?.value;
}

async function grabFramePng(cdp, frameIndex) {
  const dataUrl = await evalJs(
    cdp,
    `(() => {
      window.__koiPond.renderFrame(${frameIndex});
      return document.getElementById('pond-canvas').toDataURL('image/png');
    })()`
  );
  const comma = dataUrl.indexOf(',');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

// Original Procedural Koi Pond Stereo Ambience (48 kHz 16-bit PCM WAV)
// Synced cleanly to the 4 pond presets:
//   0.0–3.5s  Calm      (gentle water hush + soft bubbling stream)
//   3.5–7.0s  Rain      (soft rain-on-pond patter + droplet plops + 4.65s click plunge)
//   7.0–11.0s Sunset    (warm dusk water lap + subtle bamboo/bell overtone)
//   11.0–15.0 Moonlight (hushed night pond + sparse night insects + 12.15s click drop)
function synthesizePondAmbienceWav(outPath, durationSec) {
  const sr = 48000;
  const totalSamples = Math.round(sr * durationSec);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);

  let seed = 40918273;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const smooth = (a, b, x) => {
    const u = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };

  // Water noise filter states (stereo decorrelated)
  let lp1L = 0, lp2L = 0, hpL = 0, prevL = 0;
  let lp1R = 0, lp2R = 0, hpR = 0, prevR = 0;

  // Raindrop plop events during Rain preset (3.5s..7.0s)
  const drops = [];
  for (let tt = 3.55; tt < 6.95; tt += 0.065 + rand() * 0.14) {
    drops.push({
      t: tt,
      f0: 520 + rand() * 780,
      pan: (rand() - 0.5) * 1.4,
      amp: 0.015 + rand() * 0.022,
      dur: 0.055 + rand() * 0.045,
    });
  }

  // Two subtle resonant click-ripple splashes at 4.65s and 12.15s
  const splashes = [
    { t: 4.65, f0: 210, f1: 640, amp: 0.11, dur: 0.24, pan: 0.04 },
    { t: 12.15, f0: 260, f1: 760, amp: 0.085, dur: 0.28, pan: 0.22 },
  ];

  // Quiet pentatonic water-bell resonance notes synced gently to acts
  const notes = [
    { t: 0.55, f: 392.00, amp: 0.026, dec: 2.2, pan: -0.3 }, // Calm G4
    { t: 2.15, f: 523.25, amp: 0.022, dec: 2.0, pan: 0.25 }, // Calm C5
    { t: 7.35, f: 329.63, amp: 0.028, dec: 2.6, pan: -0.2 }, // Sunset E4
    { t: 9.15, f: 440.00, amp: 0.024, dec: 2.4, pan: 0.32 }, // Sunset A4
    { t: 11.40, f: 293.66, amp: 0.026, dec: 2.8, pan: -0.15 }, // Moonlight D4
    { t: 13.30, f: 587.33, amp: 0.020, dec: 2.5, pan: 0.20 },  // Moonlight D5
  ];

  // Base continuous water / rain / night insect bed
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sr;
    const masterEnv = smooth(0, 0.45, t) * (1 - smooth(durationSec - 0.65, durationSec, t));

    const calmW = 1 - smooth(3.25, 3.75, t);
    const rainW = smooth(3.25, 3.75, t) * (1 - smooth(6.75, 7.25, t));
    const sunsetW = smooth(6.75, 7.25, t) * (1 - smooth(10.75, 11.25, t));
    const moonW = smooth(10.75, 11.25, t);

    const wL = rand() * 2 - 1;
    const wR = rand() * 2 - 1;

    // Gentle low-passed pond lap
    const lapMod = 0.72 + 0.28 * Math.sin(t * 1.15) + 0.14 * Math.sin(t * 2.4);
    const waterCut = 0.028 * (calmW + sunsetW * 0.8 + moonW * 0.55) + 0.055 * rainW;
    lp1L += waterCut * (wL - lp1L);
    lp2L += waterCut * 0.65 * (lp1L - lp2L);
    lp1R += waterCut * (wR - lp1R);
    lp2R += waterCut * 0.65 * (lp1R - lp2R);

    // Soft band-passed rain shimmer hiss (only during Rain)
    hpL = 0.92 * (hpL + wL - prevL);
    prevL = wL;
    hpR = 0.92 * (hpR + wR - prevR);
    prevR = wR;

    const waterAmp = (0.11 * calmW + 0.14 * rainW + 0.095 * sunsetW + 0.068 * moonW) * lapMod;
    const rainHiss = rainW * 0.036;

    // Subtle warm harmonic pond drone
    const drone =
      (Math.sin(2 * Math.PI * 130.81 * t) * 0.5 + Math.sin(2 * Math.PI * 196.0 * t) * 0.3) * 0.015 * (calmW + sunsetW * 1.15) +
      (Math.sin(2 * Math.PI * 110.0 * t) * 0.55 + Math.sin(2 * Math.PI * 164.81 * t) * 0.28) * 0.014 * (rainW * 0.7 + moonW * 1.1);

    // Very delicate distant nocturnal cricket pulse (Moonlight only)
    const insectEnv = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 3.6 * t), 8) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.45 * t));
    const insect = moonW * insectEnv * Math.sin(2 * Math.PI * 3950 * t) * 0.0042;

    left[i] = (lp2L * waterAmp + hpL * rainHiss + drone + insect * 0.65) * masterEnv;
    right[i] = (lp2R * waterAmp + hpR * rainHiss + drone + insect * 1.15) * masterEnv;
  }

  // Mix raindrop plops (rising pitch bubble-drop chirp)
  for (const d of drops) {
    const start = Math.floor(d.t * sr);
    const len = Math.floor(d.dur * sr);
    const gL = Math.sqrt(0.5 * (1 - Math.max(-1, Math.min(1, d.pan))));
    const gR = Math.sqrt(0.5 * (1 + Math.max(-1, Math.min(1, d.pan))));
    let phase = 0;
    for (let k = 0; k < len; k++) {
      const idx = start + k;
      if (idx >= totalSamples) break;
      const u = k / len;
      const freq = d.f0 * (1 + 1.35 * u * u);
      phase += (2 * Math.PI * freq) / sr;
      const env = Math.sin(Math.min(1, u * 7) * Math.PI * 0.5) * Math.exp(-u * 6.5);
      const s = Math.sin(phase) * env * d.amp;
      left[idx] += s * gL;
      right[idx] += s * gR;
    }
  }

  // Mix click-ripple splashes
  for (const sp of splashes) {
    const start = Math.floor(sp.t * sr);
    const len = Math.floor(sp.dur * sr);
    const gL = Math.sqrt(0.5 * (1 - sp.pan));
    const gR = Math.sqrt(0.5 * (1 + sp.pan));
    let phase = 0;
    for (let k = 0; k < len; k++) {
      const idx = start + k;
      if (idx >= totalSamples) break;
      const u = k / len;
      const freq = sp.f0 + (sp.f1 - sp.f0) * Math.pow(u, 0.7);
      phase += (2 * Math.PI * freq) / sr;
      const env = Math.sin(Math.min(1, u * 10) * Math.PI * 0.5) * Math.exp(-u * 5.2);
      const s = (Math.sin(phase) * 0.7 + Math.sin(phase * 2.02) * 0.25) * env * sp.amp;
      left[idx] += s * gL;
      right[idx] += s * gR;
    }
  }

  // Mix soft harmonic water-bell resonance notes
  for (const n of notes) {
    const start = Math.floor(n.t * sr);
    const len = Math.floor(n.dec * sr);
    const gL = Math.sqrt(0.5 * (1 - n.pan));
    const gR = Math.sqrt(0.5 * (1 + n.pan));
    for (let k = 0; k < len; k++) {
      const idx = start + k;
      if (idx >= totalSamples) break;
      const dt = k / sr;
      const env = Math.min(1, dt / 0.035) * Math.exp(-dt * (3.2 / n.dec));
      const s = (Math.sin(2 * Math.PI * n.f * dt) + 0.22 * Math.sin(2 * Math.PI * n.f * 2.0 * dt) * Math.exp(-dt * 2.5)) * env * n.amp;
      left[idx] += s * gL;
      right[idx] += s * gR;
    }
  }

  // Write 16-bit PCM Stereo WAV
  const dataBytes = totalSamples * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  let off = 44;
  for (let i = 0; i < totalSamples; i++) {
    const l = Math.max(-0.92, Math.min(0.92, left[i]));
    const r = Math.max(-0.92, Math.min(0.92, right[i]));
    buf.writeInt16LE(Math.round(l * 32767), off);
    buf.writeInt16LE(Math.round(r * 32767), off + 2);
    off += 4;
  }
  fs.writeFileSync(outPath, buf);
}

// Verify MP4 moov atom appears before mdat (+faststart check)
function checkFastStart(mp4Path) {
  const fd = fs.openSync(mp4Path, 'r');
  const fileSize = fs.fstatSync(fd).size;
  let offset = 0;
  let moovOffset = -1;
  let mdatOffset = -1;
  const hdr = Buffer.alloc(16);
  while (offset + 8 <= fileSize) {
    fs.readSync(fd, hdr, 0, 16, offset);
    let size = hdr.readUInt32BE(0);
    const type = hdr.toString('ascii', 4, 8);
    if (size === 1) {
      size = Number(hdr.readBigUInt64BE(8));
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (type === 'moov') moovOffset = offset;
    if (type === 'mdat') mdatOffset = offset;
    if (size < 8) break;
    offset += size;
  }
  fs.closeSync(fd);
  return { faststart: moovOffset >= 0 && mdatOffset >= 0 && moovOffset < mdatOffset, moovOffset, mdatOffset };
}

async function encodeFromChrome(cdp, mp4Path, wavPath, crf) {
  const ffmpegArgs = [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-framerate', String(FPS),
    '-i', '-',
    '-i', wavPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', 'slow',
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    mp4Path,
  ];

  const ff = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr += d.toString(); });
  const ffDone = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}:\n${ffErr.slice(-1500)}`));
    });
  });

  await evalJs(cdp, 'window.__koiPond.reset()');
  const tStart = Date.now();

  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const pngBuf = await grabFramePng(cdp, f);
    if (!ff.stdin.write(pngBuf)) {
      await new Promise((r) => ff.stdin.once('drain', r));
    }
    if ((f + 1) % 150 === 0 || f === TOTAL_FRAMES - 1) {
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      console.log(`Captured ${f + 1}/${TOTAL_FRAMES} frames (${elapsed}s elapsed)`);
    }
  }
  ff.stdin.end();
  await ffDone;
}

async function main() {
  const args = process.argv.slice(2);
  const previewOnly = args.includes('--preview-stills');
  const crfArg = args.find((a) => a.startsWith('--crf='));
  let crf = crfArg ? parseInt(crfArg.split('=')[1], 10) : 18;

  const { server, port } = await startStaticServer(PROJECT_DIR);
  const { proc: chromeProc, cdp, profileDir } = await launchChrome();

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const loadDone = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html?capture=1` });
    await loadDone;
    await evalJs(cdp, 'document.fonts ? document.fonts.ready : Promise.resolve()');

    // Performance & Determinism verification
    const check = await evalJs(
      cdp,
      `(() => {
        const t0 = performance.now();
        for (let i = 0; i < 60; i++) window.__koiPond.renderFrame(i);
        const dt60 = performance.now() - t0;
        const p1 = document.getElementById('pond-canvas').toDataURL('image/png');
        window.__koiPond.reset();
        window.__koiPond.renderFrame(59);
        const p2 = document.getElementById('pond-canvas').toDataURL('image/png');
        window.__koiPond.reset();
        return {
          info: window.__koiPond.getInfo(),
          msPerFrame: +(dt60 / 60).toFixed(2),
          deterministic: p1 === p2,
        };
      })()`
    );
    console.log('Engine check:', JSON.stringify(check));
    if (!check.deterministic) {
      throw new Error('Determinism check FAILED: frame 59 differed after reset!');
    }

    const stillsDir = path.join(PROJECT_DIR, 'stills');
    fs.mkdirSync(stillsDir, { recursive: true });

    if (previewOnly) {
      const previewShots = [
        { f: 118, name: 'preview_01_calm_swarm_2.0s.png' },
        { f: 124, name: 'preview_01b_calm_finflow_2.07s.png' },
        { f: 300, name: 'preview_02_rain_ripple_dart_5.0s.png' },
        { f: 560, name: 'preview_03_sunset_school_9.33s.png' },
        { f: 752, name: 'preview_04_moonlight_ripple_12.53s.png' },
      ];
      for (const s of previewShots) {
        const png = await grabFramePng(cdp, s.f);
        const dbg = await evalJs(cdp, 'window.__koiPond.getDebugState()');
        fs.writeFileSync(path.join(stillsDir, s.name), png);
        console.log(`Saved ${s.name} (${png.length} bytes) | ${JSON.stringify({ preset: dbg.preset, foods: dbg.foods, ripples: dbg.ripples, startled: dbg.startledKois })}`);
      }
      return;
    }

    const wavPath = path.join(PROJECT_DIR, '.tmp_pond_ambience.wav');
    const mp4Path = path.join(PROJECT_DIR, 'ascii-koi-pond-1080p60.mp4');

    console.log('Synthesizing 15.00s original stereo koi pond ambience (48 kHz)...');
    synthesizePondAmbienceWav(wavPath, DURATION);

    // Encode at starting CRF (18), raise CRF if ever > 40 MB
    while (true) {
      console.log(`Encoding ${TOTAL_FRAMES} frames @ 1920x1080 60fps (CRF ${crf})...`);
      await encodeFromChrome(cdp, mp4Path, wavPath, crf);
      const sizeBytes = fs.statSync(mp4Path).size;
      const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
      console.log(`Encoded MP4 size: ${sizeBytes} bytes (${sizeMb} MB)`);
      if (sizeBytes < MAX_MP4_BYTES || crf >= 24) break;
      crf += 2;
      console.log(`File exceeds 40 MB limit, re-encoding with CRF ${crf}...`);
    }

    fs.rmSync(wavPath, { force: true });

    // Remove preview stills if present, extract fresh QA stills directly from the encoded MP4
    for (const f of fs.readdirSync(stillsDir)) {
      if (f.endsWith('.png')) fs.rmSync(path.join(stillsDir, f), { force: true });
    }

    const qaStills = [
      { ts: '00:00:02.000', name: '01_calm_food_swarm_2.0s.png' },
      { ts: '00:00:02.100', name: '01b_calm_fin_flow_2.1s.png' },
      { ts: '00:00:05.000', name: '02_rain_click_ripple_dart_5.0s.png' },
      { ts: '00:00:09.300', name: '03_sunset_school_follow_9.3s.png' },
      { ts: '00:00:12.550', name: '04_moonlight_ripple_12.55s.png' },
    ];
    for (const st of qaStills) {
      const outStill = path.join(stillsDir, st.name);
      execFileSync('ffmpeg', [
        '-y',
        '-ss', st.ts,
        '-i', mp4Path,
        '-frames:v', '1',
        outStill,
      ], { stdio: 'ignore' });
      console.log(`Extracted QA still: ${outStill} (${fs.statSync(outStill).size} bytes)`);
    }

    // Run ffprobe & faststart check
    const probeJson = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-print_format', 'json',
      mp4Path,
    ], { encoding: 'utf-8' });
    const probe = JSON.parse(probeJson);
    const fast = checkFastStart(mp4Path);
    const vStream = probe.streams.find((s) => s.codec_type === 'video');
    const aStream = probe.streams.find((s) => s.codec_type === 'audio');
    const sizeBytes = fs.statSync(mp4Path).size;

    console.log('\n=== FFPROBE QA SUMMARY ===');
    console.log(JSON.stringify({
      file: mp4Path,
      sizeBytes,
      sizeMB: +(sizeBytes / (1024 * 1024)).toFixed(2),
      duration: +Number(probe.format.duration).toFixed(3),
      faststart: fast,
      video: vStream ? {
        codec: vStream.codec_name,
        profile: vStream.profile,
        width: vStream.width,
        height: vStream.height,
        pix_fmt: vStream.pix_fmt,
        r_frame_rate: vStream.r_frame_rate,
        avg_frame_rate: vStream.avg_frame_rate,
        nb_frames: vStream.nb_frames,
        bit_rate: vStream.bit_rate,
      } : null,
      audio: aStream ? {
        codec: aStream.codec_name,
        sample_rate: aStream.sample_rate,
        channels: aStream.channels,
        bit_rate: aStream.bit_rate,
      } : null,
    }, null, 2));
  } finally {
    cdp.close();
    chromeProc.kill('SIGKILL');
    server.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
