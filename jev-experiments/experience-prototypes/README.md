# Jev experience prototypes

[Open the deployed prototype](https://jev-experiences.vercel.app). This branch rebuilds the experiment gallery around things people can manipulate, play, hear, compare, and inspect. It contains 29 experiment pages, shared light/dark/system themes, and three shareable layouts on the same routes.

The design question is whether an artifact-first studio, a controls-first comparison desk, or a narrative evidence notebook makes the experiments easier to understand. These are reviewable prototypes on `jev-experience-prototypes`. No winning layout has been selected yet.

## Try these first

- [Interfaces that listen](https://jev-experiences.vercel.app/#experiment/ui): replay a recorded construction, fill real fields, trigger local actions, compose another interface, or revise a version. Jev selects typed components through json-render. Layout and entrance animations reveal the changes. Account settings, apartment comparison, and event planning each have completed recorded builds.
- [Paste what belongs](https://jev-experiences.vercel.app/#experiment/paste): follow source facts into destination fields, accept individual values, fill a form, undo, and distinguish personal from work or obsolete information. The downloadable [browser companion](https://jev-experiences.vercel.app/companion.zip) applies the same interaction to ordinary website forms. See [installation and limitations](extension/README.md).
- [The next useful question](https://jev-experiences.vercel.app/#experiment/journeys): navigate a branching drink-order journey. One Jev request evaluated all 81 possible preference states. The independent menu filter checks compatibility and determines when a unique drink exists. No live token is needed to explore the recorded paths.
- [A table that understands](https://jev-experiences.vercel.app/#experiment/semantic-table): ask a semantic question of eight complete support conversations, filter the answers, inspect the evidence, correct labels, and export the review.
- [Undo what you meant](https://jev-experiences.vercel.app/#experiment/undo): select changes by meaning, review that selection, and animate their reversal without reverting unrelated changes.
- [What changed that matters?](https://jev-experiences.vercel.app/#experiment/changes): alter a source fact and inspect which conclusions need review against an independent dependency list.
- [Navigation replays](https://jev-experiences.vercel.app/#experiment/games): play and scrub actual MiniGrid traces, change policies and seeds, and inspect the agent's observation. There are 239 completed episodes, including unsuccessful episodes. One interrupted episode remains in the evidence download.
- [Music](https://jev-experiences.vercel.app/#experiment/music): hear recorded Jev motifs in a four-part procedural arrangement, change tempo, mute parts, alter notes, request another arrangement, and export MIDI or JSON.
- [Pixel compositions](https://jev-experiences.vercel.app/#experiment/pixels) and [animated worlds](https://jev-experiences.vercel.app/#experiment/worlds): Jev selects composition parameters; code supplies a visible drawing vocabulary. Palette, environment, density, motifs, and movement affect the render. These are constrained composition experiments, not unrestricted image generation.
- [JudgeBench](https://jev-experiences.vercel.app/#experiment/judge): read the full question and both candidate answers before revealing the dataset label and Jev judgment. Search the cases or inspect only mistakes. The language experiment likewise shows every writer candidate and the reference answer, with executable instruction-check outcomes.

## Compare the page layouts

The state stays mounted while the layout changes. Use the floating bar or left/right arrow keys outside editing controls.

| Layout | Link | Emphasis |
| --- | --- | --- |
| Studio | [Open](https://jev-experiences.vercel.app/?variant=studio#experiment/paste) | Large artifact, compact controls |
| Comparison | [Open](https://jev-experiences.vercel.app/?variant=comparison#experiment/paste) | Controls first, followed by a full-width comparison |
| Notebook | [Open](https://jev-experiences.vercel.app/?variant=notebook#experiment/paste) | Question first, stacked artifact and controls |

The floating layout selector intentionally remains visible on this separately deployed prototype. It should be removed when a design is promoted into the main application.

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

- [json-render](https://json-render.dev/docs/jev), pinned at 0.21.0, supplies the catalog, schema checks, composition loop, renderer, state bindings, and action contract. Its documentation still calls the APIs unreleased, but the installed 0.21.0 package exports them. We supply a native Jev Gateway adapter and original React components. A batched layout produced an unreachable tree; sequential composition was inspectable. Apartment generation improved after the catalog offered complete apartment cards instead of independent rent/button fragments. Earlier partial attempts remain in `results/composed-ui.json`.
- [TanStack Table](https://tanstack.com/table/latest/docs/introduction) handles table mechanics. Jev contributes semantic cells rather than replacing sorting or table state.
- [React Flow](https://reactflow.dev/learn) renders the routing and verification handoffs. A diagram of a route is not evidence that the downstream task succeeded, so those claims stay separate.
- [Tone.js](https://tonejs.github.io/) supplies audio scheduling and synthesis; [@tonejs/midi](https://github.com/Tonejs/Midi) supplies MIDI encoding. Motion supplies animated layout changes. These libraries do the mechanical work; the model contributes bounded decisions.
- [React Grab](https://www.react-grab.com/) is a useful follow-up for pointing a coding agent at a selected element's source. It was researched, not installed into the public app. Agentation and A2UI/AG-UI are adjacent options; an annotation or agent-event framework is not needed for these local artifact interactions yet.

Jev is advertised as free on [Vercel Gateway](https://vercel.com/ai-gateway/models/jev) during a promotion ending September 25, 2026. Recovered successful calls reported zero cost. Unknown attempt costs remain unknown. The native response's billing metadata is preserved; no arbitrary per-call reserve is presented as actual spend. This pass uses Jev for new decisions and the previously recorded local-writer results for comparison; it does not launch a new Sonnet/Qwen generation job.

## Honest limits and the next useful investigations

The UI makes the experiments easier to inspect; it does not establish broad model quality. Eight authored support conversations are an interaction fixture, and 81 café states cover one finite menu. The journey audit checks valid stopping and unanswered questions in all 81 states, not globally optimal information gain. Generative UI still needs supplied text, data, components, and action bindings. Personal memory is explicitly entered local notes, not an agent that automatically knows a user's life.

The learning pages expose the prior experiments' actual limits. Reward training is a small linear policy, with independent test accuracy shown next to teacher reward. The SmolLM2 replica has real parameter updates but is not yet Jev-output distillation, and its binary task performs poorly. Prompt search ties the unchanged prompt on the held-out set. The next substantial research work is balanced multi-task distillation, a larger multi-seed optimization study, and reward training evaluated by independent executable outcomes. None of those larger training studies is claimed as completed by this UI pass.

Context filtering now makes kept and dropped text visible, but needs a downstream task-success comparison. Vision exposes the actual image and the failed caption, then lets a user repair the evidence passed to Jev. A stronger image-to-decision experiment should compare several vision encoders with independently labeled visual tasks.

## Run and deploy

From this folder:

```sh
bun install --frozen-lockfile
bun start
```

The app runs on port 5191 and its API on 8793. Existing local credentials are read privately from the authorized zshrc and the parent lab's private access-token file. Environment variables `AI_GATEWAY_API_KEY` and `LAB_ACCESS_TOKEN` can be supplied instead. Public visitors can use recorded examples; live calls require the private lab token. No gateway key is bundled into the client or extension.

```sh
bun run build
bun test server
bun run recover
bun run record
bun scripts/record-journeys.ts
bun scripts/record-pixels.ts
bun scripts/configure-cloud.ts
bunx --bun vercel deploy --prod --yes
```

Preparation overlays new results onto the original lab's records and joins full inputs from pinned upstream datasets. Local recovery/metric recomputation needs the parent lab's request logs, dataset cache, and Python environment. A fresh checkout can use the original lab's documented dataset preparation to restore that cache. Vercel uploads prepared `public/data`; it does not fetch repositories or run training during the build. `public/data`, dependencies, provider credentials, caches, and upstream checkouts are excluded from the commit.

## Validation

- TypeScript and Vite production build pass with Bun.
- Six retry/validation tests pass, covering 19 assertions.
- All 29 experiment pages opened in a real browser without JavaScript exceptions at desktop width. No horizontal overflow appeared at 1440px or 390px.
- Real deployed checks returned 401 for anonymous calls, 400 for an invalid authenticated payload, and 200 for a live Jev judgment. A streamed interface revision finished in 832 ms, removed the requested switch, and preserved an edited form value; this is one observation, not a latency benchmark.
- The evidence audit confirms all 200 JudgeBench cases include both full candidates and verifies original completed predictions were not replaced.
- Music playback advanced and stopped in the browser; exported MIDI decoded into four tracks with 32 melody, 24 harmony, 8 bass, and 16 drum notes. The companion content script filled five fields and preserved a later manual edit on undo, using synthetic extension messaging.
- Three recorded generated interfaces finish successfully. The browser companion is an unpacked prototype with installation instructions and two sample pages. Browser-specific installation and custom website widgets still need broader compatibility testing.

Sources and older study methods remain in the parent lab's `SOURCES.md` and `README.md`. This folder contains original prototype code, new decision records, derived recovery records, and investigation notes, not copies of downloaded repositories.
