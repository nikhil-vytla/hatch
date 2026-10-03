# Who said that? (prototype)

A better transcript from a noisy room. You tag two voices for a few seconds each, and every line of
the conversation then gets four typed questions:

| Question | Type | Answered by |
|---|---|---|
| Sounds like whom? | choice: me / friend / someone else | voice similarity to the two tags (CAM++ embedding) |
| Same topic as our chat? | yes/no | sentence similarity to the last few lines we said (all-MiniLM-L6-v2) |
| Continues the last line? | yes/no | a repeated word, a sentence left hanging on "and", a line within a breath |
| Part of our conversation? | yes/no | the three above, combined |

The rules are hand-set in `decide.proto.ts`. Nothing is trained, and no Jev output is used; TypeSafe's
Master Customer Agreement §2.3(b) forbids training on Jev's answers. On the visitor's own key, Jev can
answer the two text questions instead, in one batched call.

This is a throwaway prototype on the `proto/who-said-that` branch. It isn't merged to main.

## Where it runs

- **The site:** `#experiment/who-said-that`, with `?v=a|b|c` switching between three views. A is a transcript with speaker chips and reasons, B a timeline with three lanes, and C is "fix my transcript", before and after.
  - **By default** it replays a recorded run with no downloads.
  - **"Run it in your browser"** runs the whole pipeline in a worker: whisper-tiny.en (~41 MB), MiniLM (~23 MB) and CAM++ (29 MB), cached after the first run.
  - **"Your own conversation"** records your microphone locally (5 s of you, 5 s of your friend, 30 s of talk). Nothing is uploaded.
- **Node:** `record.proto.ts` (scores against a clip's script) and `cli.proto.ts` (three WAVs in, a Markdown transcript out).
- **The Mac menu-bar app:** `jev-experiments/apps/who-said-that-mac/` records locally and calls the CLI.

## Results (1 Oct 2026)

Both clips are synthetic: Kokoro-82M voices reading an authored script over synthetic café babble and room tone, so every line's speaker is known. A segment counts as right if its label matches the scripted line it overlaps most.

| Clip | Full pipeline | CAM++ voice alone | MFCC fingerprint + rules |
|---|---|---|---|
| Café, floor plan (rules written against it) | 24/26 (92%) | 25/26 (96%) | 24/26 (92%) |
| Café, trip to Porto (held out, never tuned on) | 13/15 (87%) | 12/15 (80%) | 6/15 (40%) |
| Café, floor plan, run live in headless Chromium (MP3 decode, WASM) | 22/26 (85%) | | |

- **Rules against voice alone:** on the clip they were written against, the topic and continuation rules slightly *lower* accuracy compared with voice alone. On the held-out clip they help.
- **The hand-made fingerprint:** 12 MFCCs plus pitch identifies clean real speakers well (23 of 24, LibriSpeech test-clean, 8 speakers) but falls apart in babble (40% held out). CAM++ is 24 of 24 on the same real speakers.
- **Latency:**
  - **On an M4 Max in Node:** about 180–270 ms of whisper-tiny per segment; CAM++ about 10–40 ms per segment; topic embedding and decisions under 25 ms for a whole clip.
  - **In headless Chromium (WASM, no WebGPU):** 27–29 s of work for 26 segments, about 1.1 s per segment, plus a one-time download.
- **Limits:**
  - Synthetic voices are easier than a real room.
  - Speech detection works on loudness, so overlapping speech and two people talking at once aren't separated.
  - One sentence split by a pause can lose its speaker ("about the north wall on Monday").
  - Similar-sounding friends will do worse.

### A bug worth knowing about

onnxruntime 1.21 (the version Transformers.js 3.8 pulls in) changes CAM++'s output when graph optimisation is on. The same features gave 11/24 speakers right against 24/24 with Python's onnxruntime. Both the Node and the browser sessions therefore set `graphOptimizationLevel: "disabled"`. The diagnosis compared our Kaldi filterbank with kaldi-native-fbank, which matched exactly, then compared the two runtimes.

## Data and model licences

| Item | Licence |
|---|---|
| Clip voices: Kokoro-82M ([onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)) | Apache-2.0 |
| Clip scripts (`clips/script.ts`, `clips/script2.ts`) and babble lines | written for this prototype |
| Speech-to-text: [Xenova/whisper-tiny.en](https://huggingface.co/Xenova/whisper-tiny.en) | Apache-2.0 |
| Topic: [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) | Apache-2.0 |
| Voice: [Wespeaker/wespeaker-voxceleb-campplus](https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus) | Apache-2.0 |
| LibriSpeech test-clean (diagnostic only, not committed) | CC BY 4.0 |

Not used: `microsoft/wavlm-base-plus-sv`, the common Transformers.js speaker model, has no licence on its model card.

## Reproduce

```sh
cd jev-experiments/experience-prototypes && bun install --frozen-lockfile && cd ..
# clips (needs kokoro-js: bun add kokoro-js in a scratch folder with clips/*.ts)
SCRIPT=./script  bun make.proto.ts out    # floor plan
SCRIPT=./script2 bun make.proto.ts out2   # Porto, held out
bun live-worlds/who-said-that/record.proto.ts out  cafe.result.json    # CAM++ (default)
bun live-worlds/who-said-that/record.proto.ts out2 porto.result.json
bun live-worlds/who-said-that/record.proto.ts out2 x.json mfcc          # MFCC fingerprint instead
bun live-worlds/who-said-that/probe-real.proto.ts <dir with multi.json + WAVs>   # real-voice speaker ID
```

CAM++ downloads once to `~/.cache/who-said-that/campplus.onnx`.
