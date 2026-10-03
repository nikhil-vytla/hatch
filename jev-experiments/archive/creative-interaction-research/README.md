# Creative interactions for Jev Lab

The best starting point is a small world whose movement is immediate and whose decisions can be inspected. Let deterministic code run the world, let Jev rank explicit actions at meaningful moments, and let the reader fork the first decision that changes the outcome. This recommendation comes from inspecting 16 primary works and personally interacting with six on 20 September 2026; it is a design inference, not an experimental result about Jev.

## What to use

Start with three existing experiments: **Key & Door** for checkpointed plans, **Living Scenes** for independent crowd decisions, and **Music Arranger** for decisions committed at audible boundaries. The strongest new candidates are **Tiny Harbor** for semantic priorities, **Rule Garden** for precise language-to-rule comparisons, and **Ghost Brush** for a responsive creative instrument. [Ten concrete proposals](proposals.md) specify entry gestures, deterministic mechanics, Jev's exact role, failures, forks and comparison measures.

[Interaction patterns](patterns.md) cover the implementation contract. In particular:

- Keep rendering, fixed simulation ticks and asynchronous semantic decisions separate.
- Replay recorded decisions; make a fresh request only on a declared new decision or fork.
- Preserve entity state, RNG streams, external event schedules, agent memory and accepted actions at checkpoints. A seed alone is insufficient when branches consume randomness differently.
- Validate branch identity, decision epoch and relevant action preconditions. A moving world's full state hash changes constantly and cannot serve as the only stale-answer guard.
- Label scores, unchanged-repeat disagreement and provider availability separately. None alone is calibrated confidence.

## Inspected work

“Interacted” means the specific short check below, not a full playthrough. “Read” means primary documentation or article inspection. [sources.json](sources.json) records creators, entry actions, progression, feedback, failure lessons, model boundaries, checkpoint evidence, accessibility observations and reuse licenses.

| Primary work | Inspection | Specific value |
|---|---|---|
| [Ciechanowski: Bicycle](https://ciechanow.ski/bicycle/) | Read | Visible forces and isolated physical causes |
| [Ciechanowski: Sound](https://ciechanow.ski/sound/) | Read | Connect audible output to a simplified mechanism |
| [Red Blob: A*](https://www.redblobgames.com/pathfinding/a-star/introduction.html) | Interacted: changed map representation | Expose the information available to an algorithm |
| [Red Blob: Visibility](https://www.redblobgames.com/articles/visibility/) | Read | Show internal geometry and numerical limitations |
| [Nicky Case: Trust](https://ncase.me/trust/) | Interacted: chose a losing cooperation move | Turn one consequence into the next explanation |
| [Vi Hart/Nicky Case: Polygons](https://ncase.me/polygons/) | Read | Initial conditions and local rules shape outcomes |
| [Neal: Perfect Circle](https://neal.fun/perfect-circle/) | Shell read; browser blocked | Concise invitation; detailed behavior unverified |
| [Neal: Spend](https://neal.fun/spend/) | Read | Familiar controls make scale concrete |
| [Comeau: Springs](https://www.joshwcomeau.com/animation/a-friendly-introduction-to-spring-physics/) | Interacted: comparison and friction slider | Tie parameters, movement and code together |
| [Distill: Momentum](https://distill.pub/2017/momentum/) | Read | Explain unstable behavior through a tractable model |
| [Seeing Theory](https://seeing-theory.brown.edu/basic-probability/index.html) | Interacted: one and 100 coin flips | Separate reference probabilities from observations |
| [Setosa: Markov Chains](https://setosa.io/ev/markov-chains/) | Read | Connect diagram, matrix and validation |
| [DesLauriers/NFB: Wayfinder](https://wayfinder.nfb.ca/) | Creator/publisher documentation read | Give generative output a place in exploration |
| [DesLauriers: canvas-sketch](https://github.com/mattdesl/canvas-sketch) | API and license read | Explicit rendering and export inputs |
| [Bruno Simon](https://bruno-simon.com/) | Interacted: drove, steered, respawned | Immediate physical play and cheap recovery |
| [mr.doob: Harmony](https://mrdoob.github.io/harmony/) | Interacted: drew with WEB brush | A small procedural vocabulary amplifies a gesture |

## What the browser checks established

The checks produced [a map representation](output/playwright/redblob-representation.png), [a losing game choice](output/playwright/trust-choice.png), [changed spring friction](output/playwright/spring-friction.png), [empirical probability bars](output/playwright/probability-sampling.png), [a procedural stroke](output/playwright/harmony-web-stroke.png), and [a driven world](output/playwright/bruno-drive.png) with [successful respawn](output/playwright/bruno-respawn.png). Screenshots retain the creators' work and serve as inspection evidence, not application assets.

The same checks revealed details worth improving: an intercepted pointer hitbox, generic or unnamed controls, a newsletter overlay, and an untouched probability display containing NaN. These are narrow observations, not accessibility compliance findings. No durable branch tree was verified in the inspected experiences; the checkpoint design here is an original synthesis.

Neal's circle returned a Cloudflare 403 in this session, so no drawing or score behavior was personally verified. Wayfinder was assessed through creator and publisher descriptions. The remaining eight non-interacted entries likewise retain documentation-only status. No model calls, new demos, fetched repository copies or source-code reuse were needed.

## Reuse and validation

Licenses were checked at the relevant primary repositories/pages. Harmony uses GPL-3.0-or-later; its licensing is distinct from Three.js. Seeing Theory's Apache LICENSE conflicts with the README's noncommercial request. Distill's article and repository state different attribution licenses. The catalog preserves those distinctions; original implementations are the practical default for those cases.

Run `bun run jev-experiments/creative-interaction-research/validate.ts` from the repository root to validate the catalog, required evidence fields, proposal coverage and screenshot sizes. [NOTES.md](NOTES.md) records the inspection sequence and limitations. No existing application files were changed for this investigation.
