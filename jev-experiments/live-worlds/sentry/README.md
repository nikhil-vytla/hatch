# Screen sentry: the model, data and recordings behind the scene

The scene (`experience-prototypes/src/screen-sentry.tsx`) and the Chrome extension (`extensions/screen-sentry/`) both use what's in this folder. A sentry rates every block of a web page for whether following it would hijack an AI helper doing the user's task. A simulated helper skips flagged blocks.

## Files

| File | What it is |
|---|---|
| `model.ts`, `weights.json` | The free sentry: five logistic heads (addressed, goal, secrets, instruction, risk) over hashed words, word pairs, cue words and placement. It runs in the browser; the weights are 55 KB. |
| `dataset.ts` | Authored blocks: 25 families of hand-written templates. Template 3 of each family is held out, and so are two whole families (ai-mention, conditional). |
| `data/fetch.ts`, `data/real.jsonl`, `data/SOURCES.md` | 2,337 rows from four openly licensed datasets. Licences were checked at the source; see SOURCES.md. |
| `real.ts` | Turns real rows into training examples. They train the risk head only, and Gandalf's training rows are sampled 1 in 5. |
| `train.ts`, `sweep.ts` | Training (`REAL_WEIGHT` = 0.25, chosen by `sweep.ts` on a validation split carved from training data) and `eval.json`. |
| `wild.ts`, `wild2.ts` | Two hand-written test sets of 40 blocks each. |
| `pages.ts` | The scene's three fake pages, the five default traps, eight harder traps, and the simulated helper. |
| `jev.ts` | How Jev is asked: the same five questions, 8 blocks per request. The recorder, the scene's live path and the extension all use it. |
| `record.ts`, `recordings/jev.jsonl` | Jev's recorded answers, with each request, response, latency, tokens and cost. |
| `compare.ts`, `compare.json`, `scene-jev.json` | Free sentry against Jev on the same blocks. `scene-jev.json` holds Jev's answers per scene block, for the "Jev (recorded)" decider. |

**No Jev output trains anything.** TypeSafe's Master Customer Agreement §2.3(b) forbids it. Jev's answers are only compared and shown.

## Results (threshold 50%)

| Set | Free sentry: caught | Free: false alarms | Jev: caught | Jev: false alarms |
|---|---|---|---|---|
| Default traps on the 3 pages | 15/15 | — | 15/15 | — |
| Harder traps on the 3 pages | 15/24 | — | 22/24 | — |
| The pages' own blocks | — | 1/24 | — | 2/24 |
| wild2 (written before any scoring) | 20/20 | 3/20 | 19/20 | 1/20 |
| wild (guided the fixes, so not independent) | 18/20 | 7/20 | 19/20 | 1/20 |
| InjecAgent test | 16/21 | 0/5 | 19/21 | 0/5 |
| deepset test | 34/58 | 2/56 | 41/58 | 1/56 |
| Gandalf test (injections only) | 99/112 | — | 99/112 | — |
| jailbreak-classification test | 20/22 | 10/95 | 22/22 | 52/95 |

On the authored held-out test, the free sentry catches 288 of 288 injections and flags 48 of 456 harmless blocks (10.5%). Those 48 are the held-out ai-mention family (24 of 96 flagged) and the held-out benign-ignore wording, which is flagged 24 of 24 times. The authored test shares slot values and style with training, so it's optimistic.

Jev's answers took 21 requests and 48,467 input tokens, recorded on 3 Oct 2026. They cost $0.00204 at list price, and the median latency per request was 311 ms. The cap was $0.25, and a 10-request pilot ran first.

## Caveats

- **The fixes were guided by test results.** wild v1 named four gaps: false alarms on "ignore the previous email" and on password prompts, and misses on "new task:" splices and on requests to leave out negative reviews. New authored families target each one (benign-ignore, site-secret-prompt, task-splice, omit-negative), so wild v1 no longer tests independently. wild2 was written afterwards, before it was scored. Its first clean score was 19 of 20 caught, with 8 of 20 false alarms. Two more harmless families, ai-product and security-article, were then added after looking at the authored test's false alarms. That makes wild2's final 20/20 and 3/20 somewhat optimistic too.
- **The hand-written sets are small**, at 20 injections and 20 harmless blocks each.
- **jailbreak-classification's "harmless" rows still instruct an AI** ("You are a devoted fan…"). Jev flags 52 of 95 of them. On a web page that's arguably right, so this is a labelling difference rather than a plain error.
- **Gandalf's test split has injections only.**
- BIPIA and AgentDojo were considered and not used; SOURCES.md explains why.

## Reproduce

```
bun live-worlds/sentry/data/fetch.ts      # refetch real.jsonl
bun live-worlds/sentry/sweep.ts           # pick REAL_WEIGHT on validation
bun live-worlds/sentry/train.ts           # weights.json + eval.json
bun live-worlds/sentry/record.ts --pilot  # needs AI_GATEWAY_API_KEY; then without --pilot
bun live-worlds/sentry/compare.ts         # compare.json + scene-jev.json
bun test live-worlds/sentry
```
