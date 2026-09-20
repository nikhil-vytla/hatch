# A change of clothes

A working wardrobe experiment: choose tagged clothing, say or type a change, let Jev select typed edits, and let code maintain one complete outfit for an animated avatar or real Lucy video. The app includes manual controls, recorded Jev replay, live BYOK Jev, undo/reset, an optional video connection, accessible control labels, dark/mobile layouts, and reduced motion. No purchase is involved.

## What actually ran

The **spoken recording** is [assets/spoken-try-on-demo.webm](assets/spoken-try-on-demo.webm): a 30.0035-second capture of actual Lucy 2.1 output, 720×1280, now 994,578 bytes, with an Opus track containing the original synthetic speech. Its stored media timeline is 29.954 seconds. It starts from an original illustrated adult presenter, not a user's camera. Four commands add a denim jacket, add black square sunglasses, “Make them pink,” and “Make them bigger.” The accepted states keep the jacket throughout. Actual sampled frames show the navy jacket and black-to-pink eyewear; the final size increase is not conclusive. Sleeve/coat proportions and pose drift, trousers turn cream in an intermediate frame, and small unrequested shirt markings appear. Canonical-state correctness does not guarantee pixel-level preservation.

The speech files were generated with macOS `say`, Samantha at 145 words/minute, then transcribed locally with [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper), `mlx-community/whisper-base.en-mlx`. No transcript was corrected by hand. Each exact transcript and canonical input matched an already recorded Jev response; `record-spoken.ts` verified both before reusing that genuine response. The resulting guarded outfit states drove Lucy, with no expected-state substitution. Actual STT/model decisions were recorded before the video session, then replayed every 7.5 seconds after the corresponding audio. **The clip demonstrates all pipeline stages, with replayed decision timing; it is not a measurement of live end-to-end latency.**

| Command | Audio duration | Local STT | Original Jev wall latency |
|---|---:|---:|---:|
| Put a denim jacket on me. | 1.63s | 273ms | 410ms |
| Add black square sunglasses, and keep the jacket. | 3.20s | 27ms | 390ms |
| Make them pink. | 0.94s | 20ms | 228ms |
| Make them bigger. | 0.92s | 20ms | 38,509ms |

`spoken-pipeline.json` contains original transcripts, model responses, accepted states, guard explanations, original timings and audio hashes. `spoken-recording.json` records the actual provider session and changes. The last model call's long wall latency is preserved; the 30-second replay does not conceal that measurement. Warm STT timing excludes model installation/download; the first transcription includes model startup.

A separate [authored control clip](assets/try-on-demo.webm) is a 30-second capture, now 905,077 bytes with a 29.905-second stored timeline. Its outfit steps were authored rather than Jev-selected, and are labeled accordingly. An initial failed Fal attempt produced zero frames; `recording-attempt-1.json` preserves it. No failed attempt is presented as generated output. Earlier Tiny/base STT trials misheard pronouns; their transcripts are retained, along with an empty-audio scripting diagnostic.

Both original MediaRecorder files lacked duration and seek cues. A [lossless container repair](media-remux/README.md) added finite duration and front-loaded seek indexes without re-encoding. Every encoded packet, presentation/decode timestamp, and decoded video/audio hash matched before and after. Capture wall time remains in `actualRecordedSeconds`; `containerDurationSeconds` describes the actual saved packet timeline. Each manifest records original and current file hashes and sizes. Chrome now reports finite duration and successfully seeks forward and backward in both clips.

## Jev evidence and code constraints

The declared development fixture has 12 cases: four cumulative edits, negation, no referent, unsupported clothing, undo, reset, catalog metadata selection, explicit target override and negated color. Each case has one wording and one completed model response, with failed provider batches stored separately. This is an authored development fixture, not a held-out benchmark.

| Version | Completed | Raw exact outcomes | Guarded exact outcomes |
|---|---:|---:|---:|
| V1 baseline | 12/12 | 9/12 | 9/12 |
| V2 explicit referent | 12/12 | 11/12 | 12/12 |

V1 could change focus when the model redundantly repeated the existing jacket. Code now updates focus only when a value actually changes. V2's pink response still selected pink for both jacket and glasses. A small, explicit interaction rule scopes simple pronoun-only edits such as “Make them pink” to the current focused garment. It discards the extra jacket-color change, retains the raw response, and explains the intervention in the UI. This guard was developed on these cases; **12/12 is guarded application behavior on the development fixture, not model accuracy or generalization**. `wardrobe-v1.jsonl`, `wardrobe-v2-raw.jsonl` and the final `wardrobe.jsonl` preserve the distinction.

The shared catalog owns available garments, colors, shape/material tags and original reference illustrations. Illegal fields/colors are rejected atomically. Accepted patches preserve unrelated state. Each video update carries the full cumulative prompt and a fresh composite reference, including a base-shirt reference after removal/reset. Stale Jev results are discarded using session/revision tickets and abort signals; older video updates cannot replace a newer revision.

## Video and privacy boundaries

The tested model is [fal's Lucy 2.1 endpoint](https://fal.ai/models/decart/lucy2-vton/realtime), `decart/lucy2-vton/realtime`, listed at $0.02/second. Direct [Decart Lucy VTON 3.5](https://platform.decart.ai/models/lucy-vton) is a different SDK/key route and was researched, not implemented or claimed here. The spoken provider connection lasted 32.971 seconds, while the saved output is 30.0035 seconds. Provider receipts were not fetched, so no exact charged amount is claimed.

The live app requires the visitor's own fal key, held only in page memory. The app's fixed-model token handler passes that supplied key to fal and returns a 70-second scoped token; it never falls back to owner credentials. The browser sends either the original illustrated stream or, after explicit opt-in, a camera video track directly to fal/Decart. No microphone is requested for video. The site does not record visitor frames. Provider data handling still applies. Jev receives only clothing state, metadata and command text; optional browser dictation may use the browser vendor's remote speech service. Local MLX transcription is specific to the recorded demo, not a claim about browser dictation.

Disconnect, page hide, unmount, connection failure and the 60-second session cap stop media tracks and close signaling/peer connections. Disconnect also forgets the fal key. The native msgpack/WebRTC adapter handles cancellation even while token authorization or the socket is still connecting. A provider acknowledgement is not proof that displayed pixels match the latest revision. Clothing geometry, identity preservation and physical fit are not guaranteed; the recorded sunglasses are rounder than the square catalog reference.

The current REST token endpoint requires `{app, token_expiration}`. The published `{allowed_apps, duration}` example returned HTTP 422; `duration` was ignored when tested alongside `app`. The working `token_expiration:70` lifetime was verified. Local recording explicitly reads literal fal credentials from the authorized `.zshrc`; inherited fal credentials were stale. Nothing sources the shell or prints keys. The loopback recorder has nonce/origin checks, at most two token requests and a three-minute process cap; it must not be deployed.

## Reproduce and integrate

App files: `src/wardrobe.tsx` exports `Wardrobe({result})`; `src/wardrobe.css`; `server/wardrobe-stream.ts`; `server/wardrobe-token.ts`; `api/wardrobe-token.ts`. The app already has React, Motion and the existing Jev BYOK API. The native video adapter uses `@msgpack/msgpack` 3.1.3. `@fal-ai/client` 1.10.1 was inspected for its current protocol/cancellation behavior; the native adapter is used at runtime.

The publication data key is `wardrobe`, decoded from `wardrobe.jsonl` via the existing records codec. Prepare copies `assets/` recursively to `public/wardrobe/`, plus `recording.json`, `spoken-recording.json`, and `spoken-pipeline.json`. All generated binary assets are under 2MB each. Model weights/dependency environments stay outside the investigation folder.

```sh
# From wardrobe-lab; real model/video commands require authorized local credentials.
bun test engine.test.ts privacy.test.ts media.test.ts
zsh synthesize-speech.sh
uv run --no-project --with mlx-whisper --with soundfile python transcribe.py
bun run record-spoken.ts
WARDROBE_SPOKEN=1 bun run record-server.ts
# Open http://127.0.0.1:8896 and press Record 30 seconds.
# No camera or microphone is accessed by this recorder.
```

`record-jev.ts` resumes checkpointed fixture recording and preserves provider failures. `summarize.ts` calculates raw versus guarded outcomes without new model calls. `review-video.ts` serves the saved clip and samples actual decoded frames. Browser speech and user camera tests were deliberately not run; the synthetic source exercised actual Fal authorization, signaling, WebRTC output, cumulative updates and disconnect.

Validation: 22 Bun tests / 138 assertions pass, covering catalog legality, atomic edits, pronoun scope, cumulative preservation, evidence replay, session/revision guards, visitor-only token authorization, cancellation before token/socket completion, older video revisions, media artifact audio/video tracks, finite duration, seek cue targets and exact manifest hashes. TypeScript compilation passes. Browser interaction and visual QA are recorded in `NOTES.md`, `output/` and `media-remux/`.
