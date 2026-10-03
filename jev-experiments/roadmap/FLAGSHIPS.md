# Next wave: flagships, multimodal Jev, installable tools

Written 2 Oct 2026 after a three-part retrospective (audience value, engineering mess, roadmap research). The working notes, about 190 screenshots and the per-page scores are in the session's job folder. This file holds the decisions and the plan.

## Decisions (2 Oct 2026)

- **Researchers come first.** The front door is credible research: a clear question, method, sample, uncertainty and data. Laypeople still get a toy on every flagship, and engineers get the exact request.
- **Recorded is the default everywhere.** Every main button replays a recording. Live Jev on the visitor's own key is a quiet secondary ("try your own"). There is no shared server key.
- **Flagships are chosen for diversity:** different questions, modalities, audiences and page formats. Some existing scenes step back into the collection, and new ones join.
- **Each page gets the format that suits it.** The three formats are a Distill-style article, a report with a companion toy, and a game with an evidence drawer. All three are being prototyped (`proto/page-formats`).
- **Camera and microphone are in scope,** processed locally in the browser by default, with recorded demos first.
- **Installable tools are in scope:** a Chrome extension, a Mac menu-bar app and a CLI.
- **Jev's outputs are never training data.** TypeSafe's Master Customer Agreement §2.3(b) forbids distillation and imitation. Free models learn from simulation (the reef's evolved policy), open teachers (Bramble mini, labelled by Qwen3.8) or our own authored labels.

## The flagship slate

| Flagship | Question it answers | Kind | Format | Status |
|---|---|---|---|---|
| Robustness: Fool Jev, prose studies, decoy | What moves a decision model that rewording doesn't? | research, text | Distill-style article | live; format prototype |
| Evaluation: answer key, open decisions | Who's right depends on who wrote the key; how close do open models get? | research | report + companion toy | live; format prototype |
| The reef | Does how fast a model decides change who survives? | simulation | game + evidence drawer | live; format prototype |
| Decisions in an interface: One box + When to ask a person | What do fast, calibrated decisions do inside a real UI? | product UX | article | live, to be combined |
| Decide | Where do models disagree with people on judgement calls? | crowd game | game | live |
| Eyes against state | What does it cost to let a model look at the screen instead of reading state? | vision | game + evidence drawer | prototype `proto/eyes-vs-state` |
| Screen sentry | Can a fast checker stop prompt injections as an AI helper browses? | agent safety | game + Chrome extension | prototype `proto/screen-sentry` |
| Who said that? | In a noisy room, who said each line, and is it part of our conversation? | audio | tool + report, Mac app | prototype `proto/who-said-that` |

These move to the collection rather than being flagships: Who can you win over?, the rumour mill. To be merged or retired: Model Routing Lab, the arena Café duplicate, Tetris realtime (into Tetris turns), and the "What one resident saw" note.

## Multimodal Jev

Jev is text-only. Its model page says "Text only. String, JSON object, or array of text values. No image, audio, or video input" ([docs](https://docs.typesafe.ai/models)). Every multimodal idea takes one of three paths, and the page says which:

1. **Perceive locally, decide with Jev.** MediaPipe, OCR, SigLIP, a detector or Smart Turn in the browser turns pixels or audio into facts. Jev answers typed questions about those facts, and the facts are shown, so visitors can see what was "seen".
2. **Decide from pixels with an open decision model.** That means SGLang `/v1/decisions` on a VLM, or OneJev. It needs a GPU, so we record the run and replay it. OneJev's training labels have no stated source, so we evaluate it as a contestant but don't ship it as a default.
3. **Free in the browser.** Small WebGPU models (FastVLM 0.5B, SmolVLM, Smart Turn v3, about 8 MB), plus small heads trained without Jev output.

### Concepts, beyond the three flagship prototypes

| Concept | Hook | Frontier problem or gain |
|---|---|---|
| Count with me | Frontier models miscount crowds. Count ducks, cars and chairs against ground truth. | counting and spatial grounding |
| Spine | Argue with an assistant that may change its mind for evidence, never for pressure. | sycophancy (Fool Jev showed doubt flips Jev) |
| Tool-call bouncer | Check each tool argument an agent proposes against the conversation. | hallucinated tool use |
| Ask or act: the agent desk | A 30-step errand; at each step, go ahead, ask you, or stop. | knowing when to ask; long-horizon drift |
| Napkin, live | Sketch a UI and it becomes a working form while you draw. | slow sketch-to-UI loops (tldraw make real) |
| Your camera roll, judged | floorplan's generate, filter, judge, select funnel for 300 holiday photos; the machine narrows, you choose. | cheap typed judge before expensive judge before human |
| Floor plan for a town | The same funnel over 5,000 layouts of Bramble Square, judged by its residents. | the funnel, applied to our own sims |
| Speed-run the truth | The same assistant at 100 ms, 1 s and 5 s per decision. Feel the difference. | latency as UX |
| Kitchen glance, Room tone, Gesture undo, The conductor, Point and ask | Ambient helpers that speak only when it matters; hands-free accept or undo; conduct the music arranger with your hands. | naturalness: proactive, quiet, embodied |

The idea we'd most like to borrow is floorplan's: show the count and cost at every stage of the funnel ("$0.55 against $248"), offer a free simulated mode, and let people state their taste in their own words.

## Installable tools

- **Chrome extension:** Screen sentry marks instruction-like text on any page, using a bundled free classifier. Your own Jev key is optional. Prototype in `proto/screen-sentry` (`extensions/screen-sentry/`).
- **Mac menu-bar app:** Who said that? writes speaker-labelled transcripts on-device. Prototype in `proto/who-said-that` (`apps/who-said-that-mac/`).
- **CLI:** `eval` runs our published studies (Fool Jev, prose, decoy) against Jev, SGLang `/v1/systemone` or a local server, with a hard spend cap. `compare` diffs two recordings, and `bouncer` checks agent tool calls. Prototype in `proto/decide-cli` (`tools/decide-cli/`).

## Quality backlog from the retrospective

| Gap | Fix | Status |
|---|---|---|
| About 350 px of header before every scene | One compact header; "Jev's role" moves into the evidence section | in progress |
| Headline strips duplicate verdicts and push play below the fold | Strips go after the first interaction on games, and replace old verdicts on benchmarks | in progress |
| The main button needs a key on 4 scenes | The recorded replay is primary; "try your own" is secondary | in progress |
| Results before play on game pages | Play first (Red Blob Games) | in progress |
| Walls of text (JudgeBench 4,815 words, Decision models on a Mac 2,416) | Split each into a scene plus a linked note | in progress |
| No "start here" per audience, no "build this" code | Entry rows on home and About; a generated SDK snippet per scene (Stripe Docs) | planned |
| Stale READMEs, duplicate results folders, dead code, duplicated helpers, three copies of transformers.js, four builds per PR | Engineering cleanup PRs | in progress |
| Creative tools with 60–90 controls | One obvious first action; the rest behind "More controls" | planned |

## References

Teaching and research exemplars, from the audience review:

- **Interaction before results:**
  - [Red Blob Games, A*](https://www.redblobgames.com/pathfinding/a-star/introduction.html): you move the blob before anything is explained.
  - [Seeing Theory](https://seeing-theory.brown.edu/): one control and two sentences per chapter.
- **Guided play:**
  - [Nicky Case, The Evolution of Trust](https://ncase.me/trust/) and [Parable of the Polygons](https://ncase.me/polygons/): a guided run, then a sandbox.
  - [Bret Victor, Up and Down the Ladder of Abstraction](http://worrydream.com/LadderOfAbstraction/): one concrete case, then abstraction with a control in hand.
- **Research writing:**
  - [Distill, Why Momentum Really Works](https://distill.pub/2017/momentum/) and [Transformer Circuits, Towards Monosemanticity](https://transformer-circuits.pub/2023/monosemantic-features/index.html): research with live figures, citable.
  - [Bartosz Ciechanowski, Gears](https://ciechanow.ski/gears/): a live figure in every paragraph.
  - [The Pudding, film dialogue](https://pudding.cool/2017/03/film-dialogue/): one case, then the whole set.
- **Live and data-heavy:**
  - [Transformer Explainer](https://poloclub.github.io/transformer-explainer/): type your own input and watch the internals.
  - [Arena leaderboard](https://lmarena.ai/leaderboard): dense rankings with intervals.
- **Tools and catalogues:**
  - [Teachable Machine](https://teachablemachine.withgoogle.com/): train, then export.
  - [Stripe Docs quickstart](https://docs.stripe.com/payments/quickstart): runnable code beside each step.
  - [explorabl.es](https://explorabl.es/): cards say what you'll do.
  - [neal.fun](https://neal.fun): one idea per page, instantly playable.

Multimodal and frontier-problem references, from the roadmap research:

- **Built on Jev:**
  - [floorplan.moldandyeast.com](https://floorplan.moldandyeast.com/) and [its paper](https://content.moldandyeast.com/): a generate, filter, judge, select funnel with Jev as the cheap judge.
  - [jev-eyes](https://github.com/LeddoEngano/jev-eyes), [Made with Jev: images](https://madewithjev.com/jev-images) and [jev-fit: screenshots](https://jev-fit.com/fit/screenshots-and-images): perception-first patterns.
- **Open decision models:**
  - [OneJev](https://github.com/OmniJev/OneJev): an open multimodal decision model; its label provenance is unclear.
  - [SGLang decision models](https://docs.sglang.io/docs/supported-models/decision_models).
- **In-browser models:**
  - [FastVLM](https://fastvlm.net/) and [SmolVLM in Transformers.js](https://pyimagesearch.com/2025/10/20/running-smolvlm-locally-in-your-browser-with-transformers-js/): in-browser VLMs.
  - [Smart Turn v3](https://huggingface.co/pipecat-ai/smart-turn-v3): 8 MB end-of-turn detection.
  - [MediaPipe gestures](https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer/web_js).
- **Turn-taking research:**
  - [Hierarchical end-of-turn model](https://arxiv.org/html/2603.13379v1).
  - [TurnBench](https://arxiv.org/html/2608.25218) and [FLEXI](https://arxiv.org/pdf/2509.22243): turn-taking is unsolved.
- **Sycophancy:**
  - [Sycophancy benchmark](https://github.com/lechmazur/sycophancy) and [clinical sycophancy](https://pmc.ncbi.nlm.nih.gov/articles/PMC13228693/).
  - [Sycophancy in stateful agents](https://arxiv.org/pdf/2607.10526).
- **Spatial reasoning and counting:** [Spatial competence](https://arxiv.org/pdf/2604.09594) and [Blind-Spots-Bench](https://arxiv.org/pdf/2607.08317).
- **Interface thinking:**
  - [tldraw make real](https://tldraw.substack.com/p/make-real-the-story-so-far).
  - [Maggie Appleton, Planning with Agents](https://maggieappleton.com/planning-agents).
  - [Ink & Switch](https://www.inkandswitch.com/).
