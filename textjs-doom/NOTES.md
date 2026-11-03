# Notes: Doom in Text.js

Goal: make Doom run in Text.js (https://textjs.org), a React 19 framework whose
apps render inside the DevTools console via `console.log("%c...", css...)`.

## Recon
- textjs.org/llms.txt lists the docs. Key facts:
  - Packages: `@textjs/app` (App Router framework, `text dev/build`), `@textjs/react`
    (renderer, `renderToConsole`), `@textjs/core` (CellBuffer, Yoga, console drivers). v1.2.0.
  - Pipeline: React -> Yoga -> CellBuffer -> row-hash gate -> RLE -> one console.log per frame.
  - Frames paced to ~15fps ("faster frames reset the DevTools throttle and are dropped").
  - `<Image pixels={{width,height,data}}>` draws RGBA as half-block pixels (2 px per cell).
  - `useInput` gives key events; `@textjs/app/testing` renders offscreen and exposes `cell(x,y)`.
  - `text run` / `renderToTerminal` renders the same tree as truecolor ANSI in a terminal (Bun).
- Lowercase DOM elements throw TX003; use Box/Text.

## Engine
- Used ozkl/doomgeneric (portable Chocolate Doom fork; implement 6 DG_* functions).
- No emscripten here. Used `pip install ziglang` (0.13.0): `zig cc -target wasm32-wasi`
  ships clang + wasi-libc, so the stock C sources compile unchanged.
  - zig rejects `-Wl,--allow-undefined-file`; not needed, `import_module` attrs suffice.
  - Needed a `system()` stub (i_system.c calls zenity) and wasi emulated signal/process-clock libs.
  - `-mexec-model=reactor` so JS calls exports (`tx_init`, `tx_tick`, ...) instead of `main`.
  - `-Os -s` -> 402 KB wasm (2.1 MB unstripped).
- Wrote a ~150 line in-memory WASI shim (doom-engine.js) so the same module runs in browser,
  Node and Bun. Doom's stdout goes to a log callback, NOT console.log (the console is the screen).
- WAD: shareware DOOM1.WAD v1.9 (md5 f0cefca49926d00903cf57551d901abe), fetched from a jsDelivr
  GitHub mirror. Not committed (4 MB, id Software copyright; shareware is redistributable
  but we keep the repo clean and fetch it in a script).
- Gotcha: `TryRunTics` busy-waits until the clock produces a new 35Hz tic. With a frozen fake
  clock it spins forever (first smoke test hung). Fix in tests: clock advances per call. In the
  app: only call `tick()` when a new tic is due, so the wait loop exits immediately.
- Smoke test in Node: boot -> title -> Esc/Enter x3 -> E1M1, ~3000 tics/s (85x realtime).

## Text.js app (app/)
- `bun add @textjs/app react react-dom`; App Router page at app/app/page.tsx, assets in app/public.
- `<Image pixels>` area-averages to the target grid. I pre-scale with nearest neighbour to exactly
  cols x rows*2 so every colour stays in Doom's 256-colour palette (better RLE) and pass `fit="fill"`.
  4:3 aspect: a cell is ~1:2, so w cols x (w*3/8) rows.
- Input: Text.js `useInput` only reports key presses (no key-up). A shooter needs hold/release, so in
  the browser I listen to raw window keydown/keyup in the capture phase (works alongside the focus pad's
  hidden textarea). In terminal/tests I fall back to useInput + synthetic release (400ms, then 150ms
  re-armed by key repeat).
- React StrictMode double-mounts in dev: guard the async boot with an `alive` flag.
- Offscreen test (`bun test`, @textjs/app/testing): boots, title draws, Esc/Enter x3 starts E1M1 and
  walking changes the frame. `app.toAnsi()` -> tools/ansi2png.py renders the cell grid to PNG.

## Real browser, headless (tools/browser-run.mjs)
- Captures console.log via CDP Runtime.consoleAPICalled and decodes the %c CSS back into pixels:
  the decoded frame is a correct Doom frame (walk, turn, fire all visible).
- Per frame at 160x61 cells: ~7.5k %c spans, ~1.2 MB of format+CSS. Every span repeats
  `font-family:"SF Mono",Menlo,...;font-size:12px;line-height:16px;margin-top:-1px;...` (~110 B),
  so CSS dominates the payload.
- text.stats(): layout ~0 ms, raster ~1 ms, "encode" (which includes the console.log call) 40 ms
  with no console client attached, 90-140 ms with one attached (CDP serialises every arg).
  Fewer bits per channel (?bits=3/4) cut spans ~25-30% and encode time ~2-3x.

## Real DevTools (tools/devtools-shot.mjs, headed Chromium under Xvfb)
- Launch chrome with --auto-open-devtools-for-tabs and a pre-seeded profile Preferences:
  devtools.preferences.currentDockState="bottom", panel-selected-tab="console". Evaluating
  DevTools internals over CDP failed ("Unable to create settings"), prefs file works.
  (uiTheme=dark did not take; screenshots are in the light theme.)
- Keys: the DevTools window has OS focus; Emulation.setFocusEmulationEnabled + click on the page,
  then Input.dispatchKeyEvent works (verified keydown/keyup reach the page and doom.key()).
- Big finding: first screenshots showed the attract demo even after starting a game. Keys were
  fine; DevTools was ~85 frames (~15 s) BEHIND the page. The Console panel cannot render 8k-span
  messages at 7 fps, and messages queue up.
- Measured by reading the HUD's frame number out of the DevTools frontend's shadow DOM over CDP
  (the [▼] dev indicator overwrites the first 3 HUD chars, so match from "#").
  DevTools renders ~17-22k spans/s regardless of frame size (Xvfb, software GL, no GPU).
- Fix: pace frames by span budget: interval = max(66ms, lastSpanCount / budget). Default 15k/s,
  `?budget=` to tune.
- Visible 1px vertical seams between some spans in DevTools on this box (DejaVu Sans Mono fallback,
  fractional advance 7.2px; spans are inline-blocks). Could not test with SF Mono/Menlo here.

## Pacing results (results/devtools-throughput.jsonl, Xvfb + software GL)
| grid | budget | page fps | DevTools fps | lag (frames) |
|---|---|---|---|---|
| 64x25 | none | 13.7 | 12.8 | 10 |
| 80x31 | none | 10.1 | 8.6 | 46 |
| 100x38 | none | 14.7 | 5.7 | 122 |
| 120x46 | none | 13.0 | 5.9 | 104 |
| 160x61 | none | 5.2 | 2.4 | 79 |
| 64x25 | 15k | 10.8 | 9.5 | 14 |
| 80x31 | 15k | 6.6 | 6.4 | 9 |
| 100x38 | 15k | 5.0 | 4.2 | 10 |
| 120x46 | 15k | 4.0 | 3.3 | 7 |
| 160x61 | 15k | 1.8 | 1.6 | 4 |
- Lag still included the boot backlog: spanCount is 0 until Text.js publishes stats, so the
  first second went out unpaced. Fixed by assuming spans = cells until stats arrive; then the
  80x31 gameplay capture showed a steady ~7 frame lag (#52 shown vs #59 sent; #65 vs #72).
  Lowered the default budget to 12k.
- Production build (`text build --adapter static`) has the same encode cost as dev (42 ms at
  160x61, 12 ms at 80x31), so it's not dev-mode overhead.

## Terminal
- `text run` works unchanged (script(1) pty capture replayed through pyte): ~20 fps at 120x46,
  ~27 KB/frame of row-diffed ANSI, vs ~1 MB per console.log frame at a similar size.
- Gotcha for me: `pkill -f <pattern>` inside a bash command kills the shell running it when the
  pattern appears in its own command line.
