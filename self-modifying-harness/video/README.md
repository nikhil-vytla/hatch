# Videos

## The D&D one-shot (round 8)

`forge-dnd.mp4` (1280×720, 12 fps, 2 minutes): one untuned `./forge` session on DeepSeek V4.1 Flash, recorded from a
real pseudo-terminal and rendered with [fframes](https://github.com/dmtrKovalenko/fframes). What happened in it is in
the experiment's README (round 8); every word on screen is in `recording/transcript.txt`.

### Recording (`recording/`)

- `drive.py` runs a command in a pseudo-terminal of a given size, follows a list of steps (`wait`, `type`, `snap` for
  a chapter marker, `until` some text appears in the new output), and writes the output as an asciinema v2 cast as it
  goes, plus the chapter markers.
- `steps.py` prints the five messages as steps; each waits for the footer to say `ready |` again.
- `stats.py` counts accepted and rejected proposals, calls and cost from the cast; the closing card's
  `session.stats.json` was then written by hand from the transcript, so it can say what the counts cannot (which tool
  was upgraded, that the dice tool never passed).
- The run, from `self-modifying-harness/prototype`:

```sh
DEEPSEEK_API_KEY=... python3 drive.py session 132 34 "$(python3 steps.py)" -- ./forge --fresh --data ~/.forge/dnd --max-cost 2
```

The committed cast has the data path replaced by `~/.forge/dnd`; the recording ran in a scratch directory.

### Rendering (`forge-video/`)

An fframes project: `src/lib.rs` replays the cast through the `vt100` crate and keeps each distinct screen as a
keyframe. Video time runs at real speed, except 6× while the footer says the model is thinking, and holds 5 s after
each turn. Each screen is drawn as one SVG `<text>` per run of same-styled cells. `src/main.rs` uses fframes' CPU
renderer, since there is no GPU here, and ffmpeg's built-in `mpeg4` encoder. fframes' prebuilt ffmpeg expects libx264
ABI 163 and Ubuntu ships 164, so H.264 is a second step.

```sh
cd forge-video            # copy the fonts first: media/README.md
cargo run --release -- render --cast ../recording/session.cast        # out.mp4, about a minute on 4 cores
ffmpeg -i out.mp4 -vf "fps=12,scale=1280:720:flags=lanczos" -c:v libx264 -preset veryslow -crf 33 -tune animation \
  -pix_fmt yuv420p -movflags +faststart forge-dnd.mp4
```

`forge-dnd.mp4` was rendered by the round 8 version of `src/lib.rs` (in git history); the current one is the round 12
renderer below, which still plays that cast but without the round 8 intro text.

## Three scenarios (round 12)

`scenarios/forge-dungeon.mp4`, `forge-budget.mp4` and `forge-life.mp4` (1280×720, 10-12 fps, 2-4 minutes each): three
fresh `./forge` sessions on DeepSeek V4.1 Flash, four messages each, no tools at the start. Each asks the agent to build
a tool that draws in ASCII and then to grow it:

| Scenario | Messages | Accepted | Rejected or refused | Calls | Cost | Real time |
|---|---|---|---|---|---|---|
| Dungeon crawl | seeded map with fog, move and reveal, traps, recap | 1 (`dungeon`, turn 3) | 14 | 375 | $0.40 | 7:46 |
| Household budget | ledger + bar chart, budgets, sparkline, recap | 3 (`expenses`, `sparkline`, `budget_math`) | 19 | 470 | $0.49 | 19:00 |
| Game of Life | simulator, pattern library, population history, recap | 1 (`life`) | 12 | 255 | $0.28 | 8:43 |

What the videos show around the replayed TUI, all taken from the session's own records:

- **Gate** (top right): each verdict lights the gate's stages in `gate.ts` order (fresh base, coverage, migration,
  checks, property rules, invariants, replay, fuzz) up to the one that decided, then stamps ACCEPTED, REJECTED or
  REFUSED (the per-turn brakes) with the gate's own reason.
- **Tools it grew** (bottom right): a row per tool, a dot per proposal (filled when accepted, red ring when rejected),
  popping in when the verdict lands.
- **Spotlight**: when a tool the agent wrote returns an ASCII drawing, the replay pauses and the drawing is shown large,
  cropped to what was drawn (not shown: repeats, empty canvases, more than one per 8 real seconds).
- **Top and bottom bars**: cost and call counters read off the TUI footer; a chapter per message with a tick for every
  verdict.

### Recording (`scenarios/recording/`)

- `dungeon.txt`, `budget.txt`, `life.txt`: the messages, one `Title|text` per line; `mksteps.py` turns one into
  `drive.py` steps (each message waits up to 15 minutes for `ready |`).
- `events.py DIR` reads the forge's OptChat chat log (`DIR/data/chat/main/*.jsonl`, every entry dated) and the cast
  header, and writes `session.events.json`: verdicts with the deciding gate stage, and drawings (the longest
  multi-line string, or list of row strings, in a non-kernel tool's result that looks drawn).
- `scrub.py CAST` replaces this machine's paths with `./data` padded to the same width, so screens replay unchanged.
- `session.meta.json` holds the title card text and accent color.

```sh
cd self-modifying-harness/prototype
DEEPSEEK_API_KEY=... python3 ../video/recording/drive.py dungeon/session 132 34 "$(python3 ../video/scenarios/recording/mksteps.py ../video/scenarios/recording/dungeon.txt)" \
  -- ./forge --fresh --data dungeon/data --max-cost 2
python3 ../video/scenarios/recording/events.py dungeon && python3 ../video/scenarios/recording/scrub.py dungeon/session.cast
```

The casts are committed gzipped (`gunzip -k scenarios/*/session.cast.gz` before rendering).

### Rendering

```sh
cd forge-video
cargo run --release -- render --cast ../scenarios/dungeon/session.cast    # reads session.{snaps,events,meta}.json next to it
ffmpeg -i out.mp4 -vf "fps=12,scale=1280:720:flags=lanczos" -c:v libx264 -preset veryslow -crf 33 -tune animation \
  -pix_fmt yuv420p -movflags +faststart forge-dungeon.mp4             # budget: fps=10, crf 35, to stay under 2 MB
```

About two minutes per 1080p30 video on 4 CPU cores. Model time is fast-forwarded 8×; turns hold 5 s; each spotlight
adds 4.6 s.
