# Experiment quality and simulation review

All 33 experiments from merged commit `4c0c40d` received a dedicated investigation. The validated index contains 160 findings: 19 experiments need repairs, 13 need a different experiment or interaction design, and one is a research map. These verdicts assess what each experiment currently demonstrates; they are not a verdict on Jev's general capability. Open [the interactive review](review.html) to filter findings and read each experiment's evidence, proposed simulation and evaluation protocol.

The user requested one subagent per experiment. The platform exhausted its total agent-thread allowance, so completed workers were reused for separate, individually scoped reviews. Every original experiment still has its own Markdown report, structured JSON and investigation. [verification.json](verification.json) lists zero missing experiments. Probes under `probes/` record their methods and outputs; some deliberately use synthetic responses to reproduce UI races and do not claim real model observations.

## What the review changed

The strongest improvements connect model decisions to a complete, inspectable artifact. Music now has one six-track score shared by audio, piano roll, editing and MIDI. Café Jev maintains real menu constraints through conversation, customization and confirmation. The new visual archive ranks a complete declared collection, and the wardrobe demo preserves actual transcription, typed wardrobe edits and video evidence.

| Work | Result | Evidence or limitation |
|---|---|---|
| Music arranger | 14 recorded arrangements, six instrument parts, audition/edit/locks/MIDI | Strong arch-contour preference remains visible; not a musical-quality win |
| Café Jev | 102 recorded cases, 304 legal recipes, deterministic order checks | 89/102 exact extractions; zero hard-constraint violations among 65 admitted recommendations |
| Smart paste | Source-preserving parser, explicit bulk review, stale-answer cancellation, edit-preserving fill/undo | Three authored examples remain, including a headquarters/address mistake |
| Generative interfaces | Correct stream EOF/UTF-8 handling, cancellation, draft preservation across versions, real shortlist state | Broader generated-workflow evaluation remains necessary |
| Visual archive | All 2,448 decisions for 204 public-domain works × six queries × two Jev modes | Caption and metadata search; no direct pixel understanding or human relevance labels |
| Wardrobe | Cumulative clothing state, recorded speech-to-Jev-to-video demo, opt-in live camera | Actual video has appearance drift; 12 fixtures are development examples |
| Icon workbench | Six complete searches over all 1,703 Lucide icons, in-context previews and export | Candidate grouping can affect the winner; no independent preference labels |
| Tetris framing | 35 complete episodes and exact trajectory verification | All 25 Jev runs cleared zero lines; code baselines completed the horizon |
| Pixel framing | 33 complete maps, 8,448 reconstructed pixel values | Formula assistance is mixed; creative images include empty thresholded outputs |
| JudgeBench reliability | All 620 pairs, three unchanged passes, all 14,880 decisions verified | Pass 1 official score 66.29%; 16.77% cross-order winner disagreement, including run-to-run variation |
| Continuous worlds | Complete Tetris, twelve-resident courtyard and Ghost Brush, with preserved synchronized branches | Small genuine crowd/brush demonstrations; full live-game model performance remains unmeasured |

These changes are published at [jev-experiments.vercel.app](https://jev-experiments.vercel.app) and proposed in [PR 57](https://github.com/nikhil-vytla/hatch/pull/57). [deployment.json](deployment.json) records the exact published commit and project root; [production-check.json](production-check.json) records deployed asset and API boundary checks. Subfolder reports give exact requests, counts and verification commands.

## What could be better

Several existing tasks disclose the answer through computed features or authored labels, then treat Jev's selection as evidence of broader reasoning. Changes exposes its dependency map; existing search and context share a six-document fixture; routing's 20 authored examples do not execute downstream handlers. Keep the useful typed decision, but evaluate it against independent outcomes and meaningful alternatives.

Many interfaces also separate a result from the input that produced it. The audits reproduced late replies overwriting changed questions, manual choices or scene settings. Fix these with versioned requests and immutable evidence before adding more presets. A probability bar attached to the wrong input is worse than no bar.

The original games have an especially visible mismatch with the intended experience. Snake waits for a model reply and has a 90-move horizon that makes a full-board win impossible. Orbital's saved runs never offered an immediate collision alternative. Key & Door replays short traces without a full playable interaction. Complete games should have their own continuously running clocks, real progression and termination, human handoff, and recoverable checkpoints. Finite comparisons remain useful as a separate view.

UI motion should explain a consequence: the exact bar adopting a new musical phrase, a resident changing destination after a sign changes, or a piece following a selected landing. Decorative animation cannot repair an experiment whose decisions do not affect its output. Pixel Studio, for example, ignored 59 of 87 recorded choices across its three scenes.

## What remains

The full JudgeBench reliability collection is complete and verified. All 7,440 evaluation records and 14,880 questions are present. [The study report](../judgment-reliability/README.md) separates the official two-order score, ordinary accuracy, repeatability and provider availability. Full Tetris, a living courtyard and Ghost Brush implement the user's agreed direction under [live-worlds](../live-worlds/README.md). Their independent review defects have regression coverage; the older Snake, Orbital and Key & Door still need the same complete-game treatment. The remaining audit repairs are prioritized individually in [review.json](review.json); completing the review does not mean all 160 findings have been fixed. New recorded experiments also need replication and held-out evaluation before broad claims.

External benchmark coverage is explicit in each report. RewardBench 2 already covers all 1,865 released groups. The next full benchmark choices have different requirements: BoolQ's 3,270 validation cases are straightforward; SciFact needs a declared retrieval candidate set and official scorer; ScreenSpot-v2 needs grounded image outputs; RULER needs full downstream reader trials rather than retention alone. A full split is valuable only when the task and scoring match the intended claim.

The [creative interaction investigation](../creative-interaction-research/README.md) covers 16 primary works and six hands-on checks. [Red Blob Games](https://www.redblobgames.com/pathfinding/a-star/introduction.html) suggests exposing input, internal state and consequence separately. [Nicky Case's Trust](https://ncase.me/trust/) shows how one playable consequence can motivate the next explanation. Those patterns inform the new prototypes without importing the creators' code.

## Validation and reproduction

```sh
bun jev-experiments/quality-and-simulation-review/build-review.ts
cd jev-experiments/experience-prototypes
bun run test
bun run build
```

Strict review validation passes for 33/33 original experiments. The integrated app passes 171 tests with 148,066 assertions across 28 files and a production build, including the live-world implementations. The eight recently integrated routes loaded at 390 px without overflow or page exceptions; a follow-up with the correct music selector confirmed all 14 arrangements loaded. Detailed interaction checks are recorded in each experiment folder. The independent timing-sketch review caught restoration bugs and is preserved with follow-up notes rather than removed.

The new components load on demand, reducing initial JavaScript from about 1,078 KB to 853 KB before compression. Sixteen literal credential values read privately from local configuration had no matches in 466 changed/new source files and 735 built files at the expanded scan point. [SECURITY.md](SECURITY.md) records the bounded key and attack-path review; [security-scan.json](security-scan.json) records the latest literal-scan result. BYOK isolation and missing-key behavior have dedicated tests; this is a bounded key-exposure check, not an assurance that all possible security issues are absent. Generated library copies, build output, caches and recording logs are excluded from the intended commit.

## Deployed interaction checks

The [independent production browser review](../live-worlds/production-review/README.md) verified continuously falling Tetris pieces, identical paired clocks, human takeover, rewind and exact restoration of preserved games. Crowd checkpoints retained resident memory, RNG, disturbances and settings; all exported paired clocks matched. Root also played Ghost Brush on the canonical site, replayed its recorded Coral nerve choice and inspected the same-stroke comparison at desktop and 390 px dark mobile sizes. These checks used local policies or recorded decisions and made no live provider requests.

## Next implementation pass

1. Measure live Tetris with real Jev responses on matched piece queues. Compare buttons, reachable landings and planner intent, plus grace-period settings. Show lines cleared, survival, stale replies and the fraction of control supplied by Jev, fallback or a human. Preserve full games and their terminal reasons.
2. Make individual crowd decisions readable. Selecting a resident should connect the notice they read, their needs, the typed choice and the resulting route. Compare contrasting notices from the same checkpoint with a local baseline.
3. Build Café Jev into a running shift, with arriving customers, changed orders, queues and stock changes. Let the existing music arranger follow the shift with transitions at phrase boundaries and reversible musical decisions.
4. Apply the complete-game and branch controls to Snake, then the 3D rescue game. Reuse the current timeline, evidence receipts and controller attribution.

These are proposed next steps; the current release does not claim these extensions are implemented.
