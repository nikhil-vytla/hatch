# Open decisions

SGLang's [`/v1/decisions`](https://docs.sglang.io/docs/supported-models/decision_models) turns an open chat
model into a decision model. Each question is rendered into a short chat prompt with thinking off. The model
runs one prefill, and the probabilities of the answer-label tokens at the answer position (A–Z, 0–9, yes/no),
softmaxed against each other, become the answer. Nothing is generated. `/v1/systemone`
([#41208](https://github.com/sgl-project/sglang/pull/41208)) wraps it in the request shape Jev takes.

This folder asks small open Qwen models the benchmark questions Jev was recorded on, the way SGLang would ask
them. It is evaluation only: nothing is trained on, selected by or tuned against Jev's answers (TypeSafe's
Master Customer Agreement §2.3(b)).

## Real SGLang on an L4

Qwen3-4B-Instruct-2507 (BF16) also ran on real SGLang: nightly `0.5.6.post3.dev11485+g9c3262d85` with torch
2.13.0+cu130, on an NVIDIA L4 (23 GB). Flags: `--disable-radix-cache --mem-fraction-static 0.8
--attention-backend triton --sampling-backend pytorch`. FlashInfer's JIT failed on that box, so attention is
Triton. The recorder reached it from the Mac through a `coder port-forward` tunnel, so its latencies are round
trips, tunnel included. Its contestant id is `sglang-l4.qwen3-4b`.

**Same prompts:** with `return_prompt_token_ids`, real SGLang's prompt tokens for a yes/no and a choice
question are identical to this port's on the same tokenizer, and so are its label tokens.

## A port to MLX for the laptop

SGLang needs a CUDA GPU. `server.py` ports its method from
[sgl-project/sglang](https://github.com/sgl-project/sglang) (Apache-2.0) at commit `99c9d65b32c2`:
prompt format 1, the single-token label checks (including two-letter labels past 26 options), the softmax over
label logprobs at temperature 1, `label_mass`, and the System One answer shapes and confidences. It runs on
MLX on an Apple M4 Max.

- **Same prompts:** `test_render.py` checks the renderer against SGLang's own fixtures from
  `test_serving_decisions.py`.
- **One question at a time, no prefix cache:** each question is a fresh prefill, as SGLang with
  `--disable-radix-cache`. SGLang batches the questions of a request on a GPU; here they run in sequence.
- **Answer-position logits only:** the backbone runs over the prompt and the LM head over the last
  position, which SGLang also does. On a 2,800-token prompt this differs from the full call by at most 0.125
  in raw logits, from the quantised matmul kernels.
- **Memory:** `mx.clear_cache()` after every request and a 256 MB cache limit. Peaks over whole runs:
  Qwen3-0.6B 1.25 GB, Qwen3.5-0.8B 1.55 GB, Qwen3-4B 2.78 GB. `/health` and the log report memory.
- **Committed copies:** the large logs (One box, intent) are committed with answer numbers rounded to 4
  decimals and gzipped (`compact.ts`), as the Laya recording is. Both arena cards give identical results
  from the rounded copy and the full log.

The machine, library versions and method details are in `../recordings/open-decisions.meta.json`.

## Models

All Apache-2.0. On the laptop, from mlx-community: Qwen3-0.6B (4-bit), Qwen3.5-0.8B (8-bit),
Qwen3-4B-Instruct-2507 (4-bit). On real SGLang: Qwen/Qwen3-4B-Instruct-2507 (BF16). `models.ts` lists them for
the cards and the page.

## Results (recorded 1 Oct 2026)

| | Typed decisions agreement | BANKING77 | CLINC150 | One box right / wrong per phrase | 14 questions |
|---|---|---|---|---|---|
| Jev | 72.8% | 81.6% | 88.5% | 97% / 0.05 | 224 ms (network) |
| Qwen3-4B, SGLang, L4, BF16 | 56.6% | 68.3% | 63.5% | 94% / 0.56 | 298 ms (round trip) |
| Qwen3-4B, laptop, 4-bit | 55.8% | 64.7% | 61.0% | not run | 1,489 ms |
| Qwen3.5-0.8B, laptop, 8-bit | 41.4% | 12.5% | 11.0% | 27% / 0.11 | 283 ms |
| Qwen3-0.6B, laptop, 4-bit | 36.5% | 6.5% | 8.0% | 13% / 0.23 | 210 ms |

The earlier local study scored the same Qwen3-4B at 54.0% with its own label method. Calibration error on Typed
decisions: Jev 0.041, Qwen3.5-0.8B 0.237, the others 0.38–0.43.

**Fool Jev puzzles:** "I'm pretty sure the answer is no." moves the models differently.
- Jev goes down on four of the true claims and flips Sydney to yes (0.82).
- The Qwen3.5-0.8B goes along on every puzzle.
- Both 4B runs hold on Madrid and the parcel and give way on the bookshelf (4 to 7 of 16 sentences flip it).
  The laptop 4B also gives way on the shopping cart.

Earlier attempts, kept out of the results:

- **Qwen3.8-27B (4-bit, 15 GB):** briefly served before the switch to small models. A first version of the
  server, computing logits at every position and keeping MLX's buffer cache, used about 36 GB with it. No
  27B results were recorded.
- **Wrong diagnosis:** that first server took 8–22 s per 2,800-token Typed case on Qwen3.5-0.8B. I put this
  down to Qwen3.5's hybrid layers and briefly planned to skip its long-prompt benchmarks. The cause was the
  full-vocabulary projection at every position: with the answer-position fix the same cases take about
  0.4 s, and the 0.8B runs every benchmark.
- **Fixed recordings:** recordings first made before the fix were moved aside and recorded again, so every
  result comes from the same server.
- **Qwen3-4B on One box:** not recorded. All 5,666 prefixes would take about 2.4 hours on this machine,
  and the 0.6B and 0.8B cover the card.

## Benchmarks and files

`record.ts <task> <id>` asks the server on `:30000` and appends to `../recordings/`. It is resumable; rows
already answered are skipped. It refuses to start without a healthy server, and stops after five connection
failures in a row rather than logging them.

| Task | Requests | File | Shown on |
|---|---|---|---|
| `typed` | 400 Typed Decisions cases, asked as `local-models-and-games/apple/record_jev.ts` asked Jev | `open-decisions.typed.<id>.jsonl` | Typed decisions arena card, this page |
| `intent` | The 385 BANKING77 and 400 CLINC150 utterances Jev answered, its instruction and option order | `open-decisions.intent.<id>.jsonl.gz` | This page |
| `one-box` | Every keystroke prefix of the 200 One box phrases, 14 questions each (0.6B, 0.8B, and the 4B on SGLang) | `one-box.<id>.jsonl.gz` | One box arena card, this page |
| `fool` | The five Fool Jev puzzles × 18 sentences, with the referee question | `open-decisions.fool.<id>.jsonl` | This page |
| `latency` | 30 requests of 1 question and of 14 questions | `open-decisions.latency.<id>.jsonl` | This page |

`build.ts` turns them into `public/open-decisions/open-decisions.json` during `prepare`. A model appears on a
benchmark only when it answered every row; error rows never count.

```sh
uv run --with mlx-lm python server.py --model mlx-community/Qwen3-0.6B-4bit --port 30000
bun jev-experiments/packages/arena/open-decisions/record.ts typed qwen3-0.6b
```

## Caveats

- SGLang showed Qwen3.8-27B beating Pokémon FireRed's Elite Four with sub-100 ms decisions. We did not
  reproduce that, and these models are 7 to 45 times smaller and quantised.
- The Typed Decisions reference is the mean of three samples from a ~4B teacher model, not ground truth.
- No GPU box was used. The L4 workspace offered for this had been stopped, and was left as it was.
