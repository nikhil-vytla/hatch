import { useEffect, useRef, useState } from "react";
import { Box, Image, Text, useConsoleStats, useInput, useViewport } from "@textjs/app";
import { createDoom } from "../lib/doom-engine.js";
import { loadAsset } from "../lib/assets";
import { CODE_TO_DOOM, inputToDoom } from "../lib/keys";

type Doom = Awaited<ReturnType<typeof createDoom>>;
type Pixels = { width: number; height: number; data: Uint8Array };

const HAS_DOM = typeof window !== "undefined" && typeof document !== "undefined";
// DevTools paints console messages on a ~50ms throttle and Text.js paces frames to
// ~15fps there; a terminal can take more.
const MIN_FRAME_MS = HAS_DOM ? 1000 / 15 : 1000 / 35;
// ?bits=N keeps the top N bits of each colour channel (default 8 = exact colours).
// Fewer bits -> more identical neighbouring cells -> fewer %c spans per console.log.
const PARAMS = HAS_DOM ? new URLSearchParams(location.search) : new URLSearchParams();
const BITS = Math.min(8, Math.max(1, Number(PARAMS.get("bits") ?? 8)));
const MASK = (((0xff << (8 - BITS)) & 0xff) * 0x010101) | 0xff000000;
// The Console panel, not Doom or Text.js, is the bottleneck: it renders roughly
// 17-22k %c spans per second (measured, Xvfb) however they are split into frames. Log faster than
// that and DevTools falls behind, showing frames seconds old. So pace frames by
// span budget: interval = spans in the last frame / budget. ?budget=N overrides.
const SPAN_BUDGET = Number(PARAMS.get("budget") ?? (HAS_DOM ? 12000 : Infinity));

/**
 * Nearest-neighbour resize of Doom's 320x200 frame to exactly the half-block
 * pixel grid we draw (cols x rows*2). Doing it here, rather than letting <Image>
 * area-average, keeps every output colour inside Doom's 256-colour palette, so
 * neighbouring cells match more often and Turbolog merges them into fewer %c spans.
 */
function fitFrame(src: Pixels, w: number, h: number, out: Pixels | null): Pixels {
  if (!out || out.width !== w || out.height !== h) out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  const s = new Uint32Array(src.data.buffer, src.data.byteOffset, src.width * src.height);
  const d = new Uint32Array(out.data.buffer);
  for (let y = 0; y < h; y++) {
    const row = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / h)) * src.width;
    for (let x = 0; x < w; x++) d[y * w + x] = s[row + Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / w))] & MASK;
  }
  return { ...out }; // fresh identity so <Image> repaints
}

/** Pick the largest 4:3 picture (Doom's intended aspect) that fits the console grid. */
export function screenSize(cols: number, rows: number) {
  // A cell is about twice as tall as wide, so 4:3 is cols : rows*2 = 4 : 3.
  const w = Math.max(16, Math.min(cols, Math.floor((rows * 8) / 3)));
  return { w, h: Math.max(6, Math.round((w * 3) / 8)) };
}

export default function Page() {
  const { cols, rows } = useViewport();
  const stats = useConsoleStats({ interval: 500 });
  const doomRef = useRef<Doom | null>(null);
  const frameBuf = useRef<Pixels | null>(null);
  const held = useRef(new Map<number, number>()); // doom key -> release deadline (terminal only)
  const [frameNo, setFrame] = useState(0);
  const [status, setStatus] = useState("Loading doom.wasm + doom1.wad…");
  const spansRef = useRef(0);
  const { w, h } = screenSize(cols, rows - 1);
  // Until Text.js reports a real span count, assume the worst case (one span per cell);
  // otherwise the first second of frames goes out unpaced and DevTools starts behind.
  spansRef.current = stats.spanCount > 0 ? stats.spanCount : w * h;

  // Boot Doom and run the 35Hz game clock.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let alive = true;
    (async () => {
      const [wasm, wad] = await Promise.all([loadAsset("doom.wasm"), loadAsset("doom1.wad")]);
      const log: string[] = [];
      const doom = await createDoom({ wasm, wad, log: (l: string) => log.push(l) });
      if (!alive) return;
      doomRef.current = doom;
      Object.assign(globalThis as any, { doom, doomLog: log }); // poke at it from the DevTools prompt
      setStatus("");
      let lastTic = doom.ticAt(performance.now());
      let lastFrame = 0;
      timer = setInterval(() => {
        const now = performance.now();
        for (const [k, deadline] of held.current) if (now >= deadline) { doom.key(false, k); held.current.delete(k); }
        // Only tick once a new tic is due, so TryRunTics never spins waiting for the clock.
        const tic = doom.ticAt(now);
        if (tic > lastTic) { lastTic = tic; doom.tick(); }
        if (doom.exited !== null) { setStatus(`Doom exited (${doom.exited}). Reload to play again.`); clearInterval(timer); }
        const frameMs = Math.max(MIN_FRAME_MS, (spansRef.current * 1000) / SPAN_BUDGET);
        if (now - lastFrame >= frameMs) { lastFrame = now; setFrame((n) => n + 1); }
      }, 5);
    })().catch((e) => setStatus(`Error: ${e?.message ?? e}`));
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // Browser: real keydown/keyup, so holding a key keeps walking. Capture phase on
  // window runs before Text.js's own listeners on the focus pad.
  useEffect(() => {
    if (!HAS_DOM) return;
    const down = new Set<string>();
    const onKey = (e: KeyboardEvent) => {
      const k = CODE_TO_DOOM[e.code];
      const doom = doomRef.current;
      if (k === undefined || !doom) return;
      const pressed = e.type === "keydown";
      if (pressed && down.has(e.code)) { e.preventDefault(); return; } // ignore auto-repeat
      if (pressed) down.add(e.code); else down.delete(e.code);
      doom.key(pressed, k);
      if (e.code === "Tab" || e.code === "Space" || e.code.startsWith("Arrow") || e.code === "AltLeft") e.preventDefault();
    };
    const releaseAll = () => { for (const c of down) doomRef.current?.key(false, CODE_TO_DOOM[c]); down.clear(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", releaseAll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", releaseAll);
    };
  }, []);

  // Terminal / offscreen tests: Text.js only reports presses, so synthesize the
  // release. Key repeat keeps re-arming the deadline while a key is held.
  useInput((e) => {
    if (HAS_DOM) return;
    const k = inputToDoom(e);
    const doom = doomRef.current;
    if (k === null || !doom) return;
    const now = performance.now();
    if (!held.current.has(k)) doom.key(true, k);
    held.current.set(k, now + (held.current.has(k) ? 150 : 400));
  });

  (globalThis as any).doomFrameNo = frameNo; // lets tools measure how far DevTools lags behind
  const doom = doomRef.current;
  if (doom) frameBuf.current = fitFrame(doom.pixels(), w, h * 2, frameBuf.current);

  return (
    <Box className="flex-col">
      {doom && frameBuf.current ? (
        <Image pixels={frameBuf.current} width={w} height={h} fit="fill" />
      ) : (
        <Box width={w} height={h} className="items-center justify-center">
          <Text bold>{status}</Text>
        </Box>
      )}
      <Text dim wrap="truncate-end">
        {status || `DOOM #${frameNo} · ${w}×${h * 2} px · ${stats.spanCount} spans · ${stats.totalMs.toFixed(1)}ms/frame · arrows/WASD move · ctrl/F fire · space/E use · esc menu`}
      </Text>
    </Box>
  );
}
