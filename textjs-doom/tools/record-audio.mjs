// record-audio.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');

const [url, out, secArg] = process.argv.slice(2);
if (!url || !out) {
  console.error('Usage: node record-audio.mjs <url> <out.wav> [seconds=14]');
  process.exit(1);
}
const seconds = secArg === undefined ? 14 : Number(secArg);
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error('seconds must be a positive number');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url);
  await page.mouse.click(640, 400); // focus game
  await page.waitForFunction(() => globalThis.doom?.sound, null, { timeout: 30000 });

  // Install an in-page recorder on the game's master output.
  await page.evaluate(async () => {
    await globalThis.doom.sound.resume();
    const ctx = globalThis.doom.sound.context;
    if (!ctx) throw new Error('No AudioContext after resume');

    const rec = (globalThis.__rec = { sampleRate: ctx.sampleRate, left: [], right: [] });
    const proc = (globalThis.__proc = ctx.createScriptProcessor(4096, 2, 2));
    proc.onaudioprocess = (e) => {
      rec.left.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      rec.right.push(new Float32Array(e.inputBuffer.getChannelData(1)));
    };

    globalThis.doom.sound.tap(proc);
    proc.connect(ctx.destination); // keeps ScriptProcessor running; outputs silence
  });

  const started = Date.now();

  // Drive the game: menu -> new game -> pistol/use.
  await sleep(2000);
  await page.keyboard.press('Escape'); await sleep(700);
  await page.keyboard.press('Enter'); await sleep(700);
  await page.keyboard.press('Enter'); await sleep(700);
  await page.keyboard.press('Enter');
  await sleep(1500);

  await page.keyboard.down('Control'); await sleep(1500); await page.keyboard.up('Control');
  await page.keyboard.down('ArrowUp'); await sleep(1000); await page.keyboard.up('ArrowUp');
  await page.keyboard.press('Space');
  await page.keyboard.down('Control'); await sleep(1000); await page.keyboard.up('Control');

  const remain = seconds * 1000 - (Date.now() - started);
  if (remain > 0) await sleep(remain);

  // Pull and downsample by 2 (average pairs) to keep transfer reasonable.
  const data = await page.evaluate(() => {
    const rec = globalThis.__rec;
    const concat = (arrs) => {
      const n = arrs.reduce((a, b) => a + b.length, 0);
      const out = new Float32Array(n);
      let o = 0;
      for (const a of arrs) { out.set(a, o); o += a.length; }
      return out;
    };
    const ds = (a) => {
      const n = Math.floor(a.length / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = (a[2 * i] + a[2 * i + 1]) * 0.5;
      return out;
    };
    return {
      sampleRate: Math.round(rec.sampleRate / 2),
      left: Array.from(ds(concat(rec.left))),
      right: Array.from(ds(concat(rec.right))),
      stats: globalThis.doom.sound.stats,
    };
  });

  const { sampleRate, left, right, stats } = data;
  const frames = Math.min(left.length, right.length);

  // Mono mix, peak, and per-second RMS.
  const mono = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const m = (left[i] + right[i]) * 0.5;
    mono[i] = m;
    const a = Math.abs(m);
    if (a > peak) peak = a;
  }
  const rmsPerSecond = [];
  for (let s = 0; s < frames; s += sampleRate) {
    let sum = 0, n = 0;
    const end = Math.min(frames, s + sampleRate);
    for (let i = s; i < end; i++) { sum += mono[i] * mono[i]; n++; }
    rmsPerSecond.push(Number(Math.sqrt(sum / n).toFixed(4)));
  }

  // 16-bit PCM stereo WAV.
  const dataSize = frames * 2 * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);              // PCM
  wav.writeUInt16LE(2, 22);              // stereo
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28); // byte rate
  wav.writeUInt16LE(4, 32);              // block align
  wav.writeUInt16LE(16, 34);             // bits per sample
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (const arr of [left, right]) {
      let v = arr[i];
      if (v > 1) v = 1; else if (v < -1) v = -1;
      wav.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), off);
      off += 2;
    }
  }

  writeFileSync(out, wav);
  console.log(JSON.stringify({
    seconds,
    sampleRate,
    stats,
    rmsPerSecond,
    peak: Number(peak.toFixed(4)),
  }, null, 2));
} finally {
  await browser.close();
}
