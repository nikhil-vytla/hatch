# The D&D one-shot video

`forge-dnd.mp4` (1280×720, 12 fps, 2 minutes): one untuned `./forge` session on DeepSeek V4.1 Flash, recorded from a
real pseudo-terminal and rendered with [fframes](https://github.com/dmtrKovalenko/fframes). What happened in it is in
the experiment's README (round 8); every word on screen is in `recording/transcript.txt`.

## Recording (`recording/`)

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

## Rendering (`forge-video/`)

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
