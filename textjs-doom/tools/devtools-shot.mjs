// Run the app in a *headed* Chromium (under Xvfb) with DevTools docked at the
// bottom on the Console panel, play a bit through CDP key events, and grab the
// whole X screen with ImageMagick `import`, i.e. a real picture of Doom being
// drawn by console.log inside DevTools.
//   xvfb-run -s "-screen 0 1600x1000x24" node tools/devtools-shot.mjs http://localhost:3123/ outdir
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const [url, out = "."] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const PORT = 9333;
const profile = mkdtempSync(`${tmpdir()}/doom-devtools-`);
// DevTools reads its UI state from the profile: dock it at the bottom, open on Console.
mkdirSync(`${profile}/Default`);
const DOCK = process.env.DOCK ?? "bottom";
const THEME = JSON.stringify(process.env.THEME ?? "dark");
writeFileSync(`${profile}/Default/Preferences`, JSON.stringify({ devtools: { synced_preferences_sync_disabled: { uiTheme: THEME }, preferences: {
  currentDockState: JSON.stringify(DOCK), uiTheme: THEME, "panel-selected-tab": JSON.stringify("console"), "panel-selectedTab": JSON.stringify("console"),
  "inspector.drawer-split-view-state": JSON.stringify({ horizontal: { showMode: "OnlyMain" } }),
  ...(process.env.SPLIT ? { "inspector-view.split-view-state": JSON.stringify({ vertical: { size: 0, showMode: "Both" }, horizontal: { size: Number(process.env.SPLIT), showMode: "Both" } }) } : {}),
} } }));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--no-sandbox", "--auto-open-devtools-for-tabs", "--window-position=0,0", `--window-size=${process.env.WIN ?? "1600,1000"}`,
  "--disable-gpu", "--force-device-scale-factor=1", url,
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 50; i++) { try { return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(200); } }
  throw new Error("no CDP");
}
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return new Promise((r) => { ws.onopen = () => r({ send, close: () => ws.close() }); });
}

await sleep(3000);
let ts = await targets();
const pageT = ts.find((t) => t.type === "page" && t.url.startsWith(url.slice(0, 20)));
let dt;
for (let i = 0; i < 30 && !dt; i++) { ts = await targets(); dt = ts.find((t) => t.url.startsWith("devtools://")); if (!dt) await sleep(300); }
if (!dt) throw new Error("DevTools target not found: " + JSON.stringify(ts.map((t) => t.url)));
const devtools = await connect(dt.webSocketDebuggerUrl);
await sleep(1500);
const page = await connect(pageT.webSocketDebuggerUrl);
// Hand Text.js the docked console size, then click the page so it has keyboard focus.
await page.send("Runtime.evaluate", { expression: process.env.SIZE ? `text.resize(${process.env.SIZE.replace("x", ",")})` : "text.responsive(true)" });
// The DevTools window owns OS focus; emulate page focus so key events reach Text.js.
await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: 400, y: 40, button: "left", clickCount: 1 });
const KEYS = {
  Escape: { code: "Escape", keyCode: 27 }, Enter: { code: "Enter", keyCode: 13 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 }, ArrowLeft: { code: "ArrowLeft", keyCode: 37 }, ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Control: { code: "ControlLeft", keyCode: 17 },
};
await page.send("Runtime.evaluate", { expression: "window.__k=[];addEventListener('keydown',e=>__k.push('+'+e.code+(e.repeat?'R':'')),true);addEventListener('keyup',e=>__k.push('-'+e.code),true);addEventListener('blur',()=>__k.push('blur'));const dk=doom.key;doom.key=(p,c)=>{__k.push('doom:'+p+':'+c);dk(p,c)}" });
const key = (type, k) => page.send("Input.dispatchKeyEvent", { type, key: k, ...KEYS[k], windowsVirtualKeyCode: KEYS[k].keyCode });
const tap = async (k, hold = 80) => { await key("rawKeyDown", k); await sleep(hold); await key("keyUp", k); };
const shot = async (name) => {
  const before = (await page.send("Runtime.evaluate", { expression: "globalThis.doomFrameNo", returnByValue: true })).result?.result?.value;
  execFileSync("import", ["-window", "root", `${out}/${name}.png`]);
  console.log("shot", name, "page frame #", before, "(compare with the #N in the HUD line of the screenshot)");
};

// Frame number in the newest HUD line DevTools has actually rendered (walks the
// DevTools frontend's shadow DOM; the HUD line reads "DOOM #<n> · WxH px · ..."; the dev
// indicator overlays its first characters, so match from the "#").
const shownFrame = async () => {
  const r = await devtools.send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
    let best = -1; const walk = (n) => { if (!n) return;
      if (n.nodeType === 3) { const m = /#(\\d+) · \\d+×\\d+ px/.exec(n.data); if (m) best = Math.max(best, +m[1]); return; }
      if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.childNodes) walk(c); };
    walk(document.body); return best; })()` });
  return r.result?.result?.value ?? -1;
};
const pageFrame = async () => (await page.send("Runtime.evaluate", { expression: "globalThis.doomFrameNo", returnByValue: true })).result?.result?.value;
if (process.env.MODE === "throughput") {
  // Let the attract-mode demo play and compare how fast the page logs frames
  // with how fast the Console panel actually shows them.
  await sleep(4000);
  if (process.env.DEBUG) console.log("dbg", JSON.stringify((await devtools.send("Runtime.evaluate", { returnByValue: true, expression: `(() => { let n = 0, sample = []; const walk = (x) => { if (!x) return; if (x.nodeType === 3) { if (x.data.includes(" px · ")) { n++; sample.push(x.data.slice(0, 40)); } return; } if (x.shadowRoot) walk(x.shadowRoot); for (const c of x.childNodes) walk(c); }; walk(document.body); return { n, sample: sample.slice(-3), url: location.href }; })()` })).result));
  const p0 = await pageFrame(), d0 = await shownFrame(), t0 = Date.now();
  await sleep(Number(process.env.SECS ?? 12) * 1000);
  const p1 = await pageFrame(), d1 = await shownFrame(), secs = (Date.now() - t0) / 1000;
  const st = (await page.send("Runtime.evaluate", { expression: "JSON.stringify(text.stats())", returnByValue: true })).result?.result?.value;
  const { cols, rows, spanCount, encodeMs } = JSON.parse(st);
  const res = { size: `${cols}x${rows}`, bits: process.env.BITS ?? 8, spans: spanCount, encodeMs: +encodeMs.toFixed(1), pageFps: +((p1 - p0) / secs).toFixed(1), devtoolsFps: +((d1 - d0) / secs).toFixed(1), lagFrames: p1 - d1 };
  console.log("THROUGHPUT " + JSON.stringify(res));
  await shot(`throughput-${res.size}`);
  devtools.close(); page.close(); chrome.kill(); process.exit(0);
}
// Wait for Doom to boot (the HUD line appears once frames flow), then start a game.
for (let i = 0; i < 40; i++) {
  const v = await page.send("Runtime.evaluate", { expression: "text.stats().frameCount", returnByValue: true });
  if ((v.result?.result?.value ?? 0) > 20) break; await sleep(250);
}
await sleep(1500); await shot("devtools-title");
for (const k of ["Escape", "Enter", "Enter", "Enter"]) { await tap(k, 120); await sleep(1000); }
await sleep(1500); await shot("devtools-e1m1");
console.log("keys seen by page:", JSON.stringify((await page.send("Runtime.evaluate", { expression: "JSON.stringify({k:__k, focus:document.hasFocus(), active:document.activeElement?.tagName})", returnByValue: true })).result?.result?.value));
await tap("ArrowUp", 1300); await tap("ArrowRight", 450); await tap("Control", 120); await sleep(150); await shot("devtools-fire");
const st = await page.send("Runtime.evaluate", { expression: "JSON.stringify((({cols,rows,fps,totalMs,encodeMs,spanCount,frameCount,skippedFrames}) => ({cols,rows,fps,totalMs,encodeMs,spanCount,frameCount,skippedFrames}))(text.stats()))", returnByValue: true });
console.log("text.stats():", st.result?.result?.value);
devtools.close(); page.close(); chrome.kill();
process.exit(0);
