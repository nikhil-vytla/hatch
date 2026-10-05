# Jev experience prototypes

[Open Jev experiments](https://jev-experiments.vercel.app). This folder is the deployed app: the home toy, Arena, Decide, Notes and every experiment scene. Vercel's project root points here.

The live scenes and the retired ones (each with a notice saying why) are listed in [`src/catalog.ts`](src/catalog.ts); `src/pages/experiment.tsx` routes them. The site is light-only, in the Toy Box identity (`src/style.css`).

## Try these first

- [Fool Jev](https://jev-experiments.vercel.app/#/): add one sentence to change Jev's mind about a question with fixed facts.
- [Decide](https://jev-experiments.vercel.app/#/decide): vote blind on a judgement call, then see how recorded models and setups answered.
- [The decoy](https://jev-experiments.vercel.app/#experiment/decoy): an option nobody should pick moves Jev's choice between two others.
- [Who can you win over?](https://jev-experiments.vercel.app/#experiment/win-over), [the rumour mill](https://jev-experiments.vercel.app/#experiment/rumour-mill) and [the reef](https://jev-experiments.vercel.app/#experiment/ocean): simulations where many agents decide, run by free in-browser models, with Jev for comparison.
- [Open decisions](https://jev-experiments.vercel.app/#experiment/open-decisions): small open Qwen models asked Jev's questions the way SGLang's `/v1/decisions` asks them.
- [Smart paste](https://jev-experiments.vercel.app/#experiment/paste): match copied facts to form fields. The downloadable [browser companion](https://jev-experiments.vercel.app/companion.zip) does the same on ordinary websites; see [installation and limitations](extension/README.md).
- [JudgeBench](https://jev-experiments.vercel.app/#experiment/judge) and [RewardBench 2](https://jev-experiments.vercel.app/#experiment/rewardbench2): read the full candidates before revealing the label and Jev's judgement. See the [RewardBench method and audit](../rewardbench2/README.md).

Every answer is recorded by default and carries a receipt. Buttons say "recorded · free" or "live · your key", and failures fall back to what's still on screen.

## What happens to failed runs

Transport failures and incorrect model answers are separate records. The gateway retries HTTP 408/429/500/502/503/504 and network failures, respects Retry-After, caps attempts, and stops at the function deadline. Permanent rejections and malformed model answers are not silently rerolled. If a provider cooldown exceeds the remaining request lifetime, the API returns that cooldown; the offline recovery worker checkpoints and waits before continuing.

The gallery's example explorer shows returned judgments, including incorrect ones. Availability details retain unanswered cases and operational history. Incomplete UI compositions retain their last valid preview and carry an explicit partial/interrupted label. A json-render `unavailable` stop is a composition decision, distinct from an HTTP capacity failure. A finished composition is still open to semantic and visual criticism.

Recovered requests reuse the original request body and never resample a completed answer. The resulting evidence audit verifies that every original completed prediction stayed unchanged.

| Recorded group | Recovered cases | Now completed |
| --- | ---: | ---: |
| Classification | 69 | 785 / 785 |
| JudgeBench | 14 | 200 / 200 |
| Robustness | 23 | 200 / 200 |
| Routing | 1 | 20 / 20 |
| Animated scenes | 12 | 20 / 20 |

All 119 recoveries retain prior errors and recovery-attempt metadata. Metrics were recomputed; original measurements remain available separately. BANKING77 returned-answer accuracy is 81.56%, CLINC is 88.5%, and JudgeBench is 77%. JudgeBench changes its preferred answer on 28% of pairs when order is reversed. Availability recovery does not make that model weakness disappear. This recovery pass does not cover every historical experiment's failed stage.

The API retry loop is bounded and the batch worker resumes from files. This prototype does not claim to implement a durable hosted job queue across Vercel invocations. That would be the next step for public background workloads.

## Components reused and findings

- [json-render](https://json-render.dev/docs/jev), pinned at 0.21.0, supplies the catalog, schema checks, composition loop, renderer, state bindings, and action contract. Its documentation still calls the APIs unreleased, but the installed 0.21.0 package exports them. We supply a native Jev Gateway adapter and original React components. A batched layout produced an unreachable tree; sequential composition was inspectable. Apartment generation improved after the catalog offered complete apartment cards instead of independent rent/button fragments. Earlier partial attempts remain in `results/composed-ui.jsonl`.
- [TanStack Table](https://tanstack.com/table/latest/docs/introduction) handles table mechanics. Jev contributes semantic cells rather than replacing sorting or table state.
- [React Flow](https://reactflow.dev/learn) renders the routing and verification handoffs. A diagram of a route is not evidence that the downstream task succeeded, so those claims stay separate.
- [Tone.js](https://tonejs.github.io/) supplies audio scheduling and synthesis; [@tonejs/midi](https://github.com/Tonejs/Midi) supplies MIDI encoding. Motion supplies animated layout changes. These libraries do the mechanical work; the model contributes bounded decisions.
- [React Grab](https://www.react-grab.com/) is a useful follow-up for pointing a coding agent at a selected element's source. It was researched, not installed into the public app. Agentation and A2UI/AG-UI are adjacent options; an annotation or agent-event framework is not needed for these local artifact interactions yet.

Jev was free on [Vercel Gateway](https://vercel.com/ai-gateway/models/jev) during a launch promotion that ended on 25 Sep 2026, so calls recorded before then report zero cost. The receipt treats a recorded $0 as unknown. Its list price is now $0.042 per million input tokens, with output free. The native response's billing metadata is preserved, and no arbitrary per-call reserve is presented as actual spend.

## Honest limits and the next useful investigations

The UI makes the experiments easier to inspect; it does not establish broad model quality. Eight authored support conversations are an interaction fixture, and 81 café states cover one finite menu. The journey audit checks valid stopping and unanswered questions in all 81 states, not globally optimal information gain. Generative UI still needs supplied text, data, components, and action bindings. Personal memory is explicitly entered local notes, not an agent that automatically knows a user's life.

The SmolLM2 pilot (now inside Decision models on a Mac) has real parameter updates, trained on dataset labels rather than Jev's outputs, and its binary task performs poorly. Prompt search ties the unchanged prompt on the held-out set. TypeSafe's terms forbid distilling Jev's outputs, so free models here learn from open teachers or from the simulation itself.

## Run and deploy

This folder is the application source for the `jev-experiments` Vercel project, deployed to https://jev-experiments.vercel.app when `main` changes something under `jev-experiments/`. The older `../web` folder is a previous implementation and isn't deployed.

From this folder:

```sh
bun install --frozen-lockfile
bun start
```

The app runs on port 5191 and its API binds to `127.0.0.1:8793`. Recorded examples are public. Live calls accept the visitor's own [Vercel AI Gateway API key](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys), kept only in browser memory until reload or disconnect. The app forwards that key per request to the fixed Jev endpoint without saving it. Deployed handlers never load environment credentials. Recording CLIs alone read `AI_GATEWAY_API_KEY` or the authorized literal assignment in zshrc. The companion explicitly saves the visitor's key in trusted extension storage and provides Disconnect.

Evidence is committed as `jev-records-v1` JSONL. The first line holds document metadata with empty arrays; subsequent lines contain `{path, index, value}` entries, one array item per line. `scripts/records.ts` and `../src/jev_lab/records.py` reconstruct the original document. `scripts/publication-manifest.ts` lists everything under `public/`: each record, and each study's own files, copies and builders. `bun run build` emits ordinary `/data/*.json` files; UI rendering and JSON downloads retain complete evidence. A file in `public/` that no entry owns fails the build.

```sh
bun run build
bun test server
bun run recover
bun run record
bun run deploy
```

`bun run deploy` pins the existing Vercel project, builds the prepared evidence locally, and deploys production. Visitors supply their own gateway keys; deployment needs no model credentials.

Preparation reconstructs the records listed in the publication manifest, including full benchmark inputs already embedded in the evidence. Local recovery/metric recomputation needs the parent lab's request logs, dataset cache, and Python environment. A fresh checkout can build and browse all evidence without that cache. Rerunning recovery still requires its original local request logs. Vercel uploads prepared `public/data`; it does not fetch repositories or run training during the build. `public/data`, dependencies, provider credentials, caches, and upstream checkouts are excluded from the commit.

## Validation

CI runs on every pull request that touches `jev-experiments/`:
- TypeScript, `bun run lint:arena` and the production build
- the app, arena and live-worlds Bun tests
- the Python tests
- the publication-index check (`roadmap/verification/publication.ts`, then `git diff --exit-code`)

Scene changes are also checked in headless Chromium at 1440 and 390 px against a local production preview.

Sources and older study methods remain in the parent lab's `SOURCES.md` and `README.md`. This folder contains original prototype code, new decision records, derived recovery records, and investigation notes, not copies of downloaded repositories.
