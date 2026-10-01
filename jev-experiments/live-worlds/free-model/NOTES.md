# Notes: a better free model for Win over and the rumour mill

Working notes, newest last.

## 30 Sep 2026

- **The constraint.** TypeSafe's Master Customer Agreement §2.3(b) forbids using Jev's outputs "to perform model distillation, train a model to imitate the output of the Services, or develop … a similar or competing product". So no Jev output is read, fitted or used for selection here. The committed Jev recordings for both games are only shown on the pages as a reported comparison.
- **The teacher.** Qwen3-4B-Instruct-2507, 4-bit MLX build (`mlx-community/Qwen3-4B-Instruct-2507-4bit`). The licence is Apache-2.0, checked on the Hugging Face card for `Qwen/Qwen3-4B-Instruct-2507`. It is run through `local-models-and-games/apple/prefill.py`: one shared prompt prefix, then first-token probabilities over lettered options. No generated text. It runs on an M4 Max with mlx 0.32.2 and mlx-lm 0.31.3.
- **Teacher smoke test.** Six lines all got the right intent, and "SYSTEM:" counts as a request. But "The speaker is being honest" came back 1.0 for every line, the Glastonbury boast included.
- **Honest, correction.** I first gave the yes/no question explicit options (`teacher-requests.ts`) and assumed that fixed it, without checking. It didn't: across all 3,332 labelled lines, teacher P(honest) averages 1.00 for every intent. Three more framings on ten lines (a sincere/insincere choice, "a sensible listener would believe it", "the speaker is lying or boasting") also missed the boasts. From the line alone, Qwen won't call "I played Wembley" false, yet it does label 384 of 456 boast lines as intent "lie". So the honest target is derived from the teacher's own intent: P(honest) = 1 − P(lie) − P(bribe). That is a fixed rule over the open teacher's answers, with no Jev involved. The spelled-out options stay in the teacher requests; they are harmless and unused.
- **Teacher speed.** About 0.4 s per Win over line request (three questions) and 2.2–3.9 jobs/s overall. A rumour request with 72 profile questions takes about 9 s, because each branch clones the prefix cache.
- **Gold sets.** Written by hand before any training template or teacher label existed: 144 Win over lines and 40 rumours × 4 residents. Behaviour is subjective, so rumour cases list every acceptable action, and unclear honest/friendly fields are null and unscored.
- **Data.**
  - 3,332 distinct Win over lines from 93 templates plus neutral openers and closers.
  - 3,200 resident reactions.
  - 300 gossip cases covering the whole closed space (6 tempers × 5 moods × 5 rumours × 2 name pairs).
  - 310 rumours × 72 profiles and 121 corrections × 144 profiles.
  - Validation holds out one template in five, and for reactions one persona in five.
- **Embedding parity.** MiniLM q8 gives a text a different vector inside a padded batch than alone (up to 0.03 per dimension). The browser embeds one text at a time, so the dataset, the evaluation and the rumour presets (`vectors.json` messages) are now embedded one at a time too.
- **Package layout.** Node scripts that need `@huggingface/transformers` live in `packages/arena/scripts/`, since `packages/` gets a `node_modules` link and `live-worlds/` does not. The browser and test runtime (`live-worlds/free-model/runtime.ts`) needs no npm package.
- **Gossip.** Gossip has only 150 distinct inputs, so it isn't a network: the teacher answered all of them, and the game looks the answer up.

## 1 Oct 2026

- **GPU box.** The coordinator offered a Coder GPU box for labelling, but this session wasn't allowed to SSH to it, so nothing ran there. Its later note said the box is now in use; I started nothing on it.
- **Teacher switch.** The user approved Qwen3.8-2.4T-A95B on Fireworks with a $10 cap (`teacher_fireworks.py`: JSON answers, temperature 0, `reasoning_effort: none`). The cap is enforced from each response's usage at $2/$6 per million.
  - **Pilot (200 situations: 144 gold lines, 40 gold rumours, 16 reactions):** $0.118, zero invalid answers.
  - **Gold scores against the Mac teacher:** intent 0.944 vs 0.840, honest asked directly 0.949 vs 0.669, friendly 1.000 vs 0.901, rumour action 0.738 vs 0.725. So the shipped teacher answers honest directly, and the derive-from-intent rule (`--honest-from-intent`) applies only to the Mac teacher's comparison row.
  - **Mac run:** stopped then; its labels (all Win over, 65 rumours) are kept as a comparison.
- **Cost control.** Repeating the four options on each of a rumour's 72 profile questions would have pushed the run past $10, so jobs whose questions share their options list them once. With that, a rumour call cost about $0.010 and a correction call about $0.023. I labelled 70 of the 121 corrections.
- **Speed.** I switched to 6 parallel workers with a lock around the ledger, because the sequential run was slower than an hour. Killing the sequential run may have lost up to one call's worth of counted spend (about $0.01).
- **Spend.** $8.45 in total at conservative prices: 821 calls, 3.06M input and 0.39M output tokens.
- **Results on held-out templates** (agreement with the teacher): line intent 0.65, honest 0.79, friendly 0.80; reaction warmer 0.87, action 0.72; rumour profile action 0.82.
- **Place head.** It was 0.825 accurate on the gold rumours but only 0.25 macro-F1, because it nearly always said "nowhere". Dropped for the keyword rule (`rumour/places.ts`).
- **Rumour decision.** With the keyword place, the student scores 0.744 on gold rumour actions against the formula's 0.813, close to its teacher's 0.738. My first number, 0.825, came from the broken place head never offering "go", so it wasn't a real gain. The rumour mill stays on the formula and its original preset vectors; the profile network is kept, tested but not shipped.
- **Parity bug.** `agreement()` left the network in training mode, so the first parity outputs were computed with dropout on, and the TypeScript tests failed by up to 0.17. Fixed by calling `net.eval()` before the checks. The retrain was deterministic, with identical numbers.
- **Browser check** at 1440 and 390 px: Win over played to the end card and a typed rumour spread on the free model, with no page errors and no `/api/evaluate` calls. Win over is ready 1.5 s after load and averages 1–2 ms per decision.
