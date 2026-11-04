// Headless smoke test of doom.wasm with no Text.js: boot, start E1M1, walk, fire; dumps PPMs.
//   node engine/smoke.mjs <dir containing doom.wasm and wad/doom1.wad>
// The fake clock advances on every read, because TryRunTics busy-waits for the next tic.
import { readFileSync, writeFileSync } from "node:fs";
import { createDoom, DoomKey } from "../app/lib/doom-engine.js";
const S = process.argv[2];
let t = 0; const logs = [];
const doom = await createDoom({ wasm: readFileSync(S + "/doom.wasm"), wad: new Uint8Array(readFileSync(S + "/wad/doom1.wad")), log: (l) => logs.push(l), now: () => (t += 0.05) });
const t1 = performance.now();
for (let i = 0; i < 35 * 6; i++) { t += 1000 / 35; doom.tick(); }
console.log("ticks/s", (35 * 6) / ((performance.now() - t1) / 1000), "frames", doom.frames);
const dump = (name) => { const p = doom.pixels(); const hdr = `P6 ${p.width} ${p.height} 255\n`; const out = Buffer.alloc(p.width * p.height * 3); for (let i = 0, j = 0; i < p.data.length; i += 4) { out[j++] = p.data[i]; out[j++] = p.data[i + 1]; out[j++] = p.data[i + 2]; } writeFileSync(`${S}/${name}.ppm`, Buffer.concat([Buffer.from(hdr), out])); };
dump("title");
// Start a new game: Enter (menu) Enter (new game) Enter (episode) Enter (skill)
for (const k of [DoomKey.ESCAPE, DoomKey.ENTER, DoomKey.ENTER, DoomKey.ENTER]) { doom.key(true, k); t += 60; doom.tick(); doom.key(false, k); for (let i = 0; i < 10; i++) { t += 1000 / 35; doom.tick(); } }
for (let i = 0; i < 35 * 3; i++) { t += 1000 / 35; doom.tick(); }
doom.key(true, DoomKey.UP); for (let i = 0; i < 35; i++) { t += 1000 / 35; doom.tick(); } doom.key(false, DoomKey.UP);
doom.key(true, DoomKey.FIRE); t += 30; doom.tick(); doom.key(false, DoomKey.FIRE); for (let i = 0; i < 4; i++) { t += 1000 / 35; doom.tick(); }
dump("ingame");
console.log(logs.slice(0, 40).join("\n"), "\n...", logs.length, "log lines; exited:", doom.exited);
