// Drive the Text.js Doom app in headless Chromium and record what actually goes
// through console.log: frame count/rate, %c spans per frame, bytes per frame.
// The last frame of each phase is decoded from its %c CSS back into pixels (PPM).
//   node tools/browser-run.mjs http://localhost:3123/ outdir
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright"); // preinstalled globally
import { writeFileSync } from "node:fs";

const [url, out = "."] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const cdp = await page.context().newCDPSession(page);
if (!process.env.NOCAPTURE) await cdp.send("Runtime.enable"); // NOCAPTURE=1: no console client attached

const frames = []; // { t, format, styles }
const other = [];
cdp.on("Runtime.consoleAPICalled", (e) => {
  const [fmt, ...rest] = e.args;
  if (e.type === "log" && fmt?.type === "string" && fmt.value.includes("%c") && fmt.value.includes("▀"))
    frames.push({ t: e.timestamp, format: fmt.value, styles: rest.map((a) => a.value) });
  else other.push(`${e.type}: ${e.args.map((a) => a.value ?? a.description).join(" ").slice(0, 200)}`);
});

function hex(c) {
  const m = /#([0-9a-f]{6})/i.exec(c); if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const r = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); if (r) return [+r[1], +r[2], +r[3]];
  return null;
}
function decode(frame) {
  const parts = frame.format.split("%c");
  const rows = [[]];
  let fg = [200, 200, 200], bg = [0, 0, 0];
  parts.forEach((text, i) => {
    if (i > 0) {
      const css = frame.styles[i - 1] ?? "";
      const f = /(?:^|;)\s*color:\s*([^;]+)/.exec(css), b = /background(?:-color)?:\s*([^;]+)/.exec(css);
      fg = (f && hex(f[1])) || [200, 200, 200]; bg = (b && hex(b[1])) || [0, 0, 0];
    }
    for (const ch of text.replaceAll("%%", "%")) {
      if (ch === "\n") { rows.push([]); continue; }
      if (ch === "⁠" || ch === "​") continue;
      rows.at(-1).push(ch === "▀" ? [fg, bg] : ch === "▄" ? [bg, fg] : ch === " " ? [bg, bg] : [fg, fg]);
    }
  });
  const pix = rows.filter((r) => r.length > 20);
  const w = Math.max(...pix.map((r) => r.length)), h = pix.length * 2;
  const buf = Buffer.alloc(w * h * 3);
  pix.forEach((r, y) => r.forEach(([t, b], x) => { buf.set(t, ((2 * y) * w + x) * 3); buf.set(b, ((2 * y + 1) * w + x) * 3); }));
  return Buffer.concat([Buffer.from(`P6 ${w} ${h} 255\n`), buf]);
}
function report(name, from) {
  const fs = frames.slice(from);
  const dur = fs.length > 1 ? (fs.at(-1).t - fs[0].t) / 1000 : 0;
  const spans = fs.map((f) => f.styles.length), bytes = fs.map((f) => f.format.length + f.styles.join("").length);
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length));
  const r = { phase: name, frames: fs.length, fps: dur ? +(fs.length / dur).toFixed(1) : 0, avgSpans: avg(spans), maxSpans: Math.max(0, ...spans), avgKB: +(avg(bytes) / 1024).toFixed(1) };
  console.log(JSON.stringify(r));
  if (fs.length) writeFileSync(`${out}/${name}.ppm`, decode(fs.at(-1)));
  return r;
}

await page.goto(url);
await page.mouse.click(640, 400); // focus the page's focus pad
if (process.env.SIZE) { // pin the console grid, e.g. SIZE=100x38 (same as typing text.resize(100, 38))
  const [c, r] = process.env.SIZE.split("x").map(Number);
  await page.waitForFunction(() => typeof globalThis.text?.resize === "function");
  await page.evaluate(([c, r]) => globalThis.text.resize(c, r), [c, r]);
}
let mark = frames.length;
await page.waitForTimeout(6000);
const results = [report("title", mark)];
mark = frames.length;
for (const k of ["Escape", "Enter", "Enter", "Enter"]) { await page.keyboard.press(k); await page.waitForTimeout(700); }
await page.waitForTimeout(1500);
results.push(report("e1m1-start", mark));
mark = frames.length;
await page.keyboard.down("ArrowUp"); await page.waitForTimeout(1200); await page.keyboard.up("ArrowUp");
await page.keyboard.down("ArrowLeft"); await page.waitForTimeout(500); await page.keyboard.up("ArrowLeft");
await page.keyboard.down("Control"); await page.waitForTimeout(150); await page.keyboard.up("Control");
await page.waitForTimeout(250);
results.push(report("e1m1-walk-turn-fire", mark));
const st = await page.evaluate(() => globalThis.text?.stats?.() ?? null);
const pick = st && Object.fromEntries(["cols", "rows", "fps", "totalMs", "layoutMs", "rasterMs", "encodeMs", "spanCount", "frameCount", "skippedFrames"].map((k) => [k, st[k]]));
console.log("text.stats():", JSON.stringify(pick));
results.push({ phase: "text.stats", ...pick });
console.log("non-frame console messages:", other.length, other.slice(0, 8));
writeFileSync(`${out}/browser-run${process.env.TAG ? "-" + process.env.TAG : ""}.json`, JSON.stringify(results, null, 2));
await browser.close();
