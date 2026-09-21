# Creative interaction research

## 2026-09-20

Started a bounded investigation of creative coding, explorable explanations and small playable systems for Jev Lab. The user explicitly asked for deeper source research, with neal.fun as a reference, and for real-time worlds with checkpoint branching. Scope: inspect 12–18 primary works, personally interact with at least four when available, distinguish observed behavior from documentation, and propose concrete experiments where semantic judgments support deterministic simulation. No paid model calls or full demo implementations are part of this task.

Plan to examine entry actions, immediate feedback, progression, causal motion, teachable failures, uncertainty, state/checkpoint design, accessibility and code reuse licenses. Store original summaries and attributed structured evidence, not copies of fetched repositories.

## Inspection log

- Primary-source pages inspected across Ciechanowski, Red Blob Games, Nicky Case/Vi Hart, Neal Agarwal, Josh Comeau, Gabriel Goh/Distill, Seeing Theory, Setosa, Matt DesLauriers/NFB, Bruno Simon and mr.doob. Read original repository/license pages where reuse matters.
- Own browser session: creative-research. Neal's circle page returned a Cloudflare 403 challenge; did not bypass it. Its entry/score shell is available through the primary page, so interaction claims remain unverified.
- Red Blob A*: clicked the alternate map representation and inspected its connected graph view. The text makes the information boundary explicit. Step forward/back and animation controls are present; did not yet exercise the entire algorithm walkthrough.
- Evolution of Trust: muted sound, started, deliberately cooperated against a cheating opponent, and observed the losing payoff explained before the next question. Text sits behind an unlabeled pointer hitbox; first text click was intercepted, then clicking the actual hitbox succeeded. This is a useful accessibility warning, not a reason to copy the old markup.
- Josh Comeau: toggled the easing/spring comparison, changed sandbox friction from 12 to 17.5 with a pointer click and ArrowRight, and observed the configuration update beside the spring. A newsletter overlay appeared during the visit; no form was submitted. The article documents mouse, touch and keyboard controls.
- Seeing Theory: flipped one coin, then triggered 100 flips; observed the empirical bars alongside the fixed reference bars. Its untouched variance chart exposed NaN before any samples, a concrete empty-state problem to avoid. Button-like controls were generic elements in the accessibility snapshot.
- Harmony: selected WEB, drew a looping pointer stroke, and saw connecting lines accumulate. Browser URL changed to #web. The source is GPL-3.0-or-later, unlike Three.js's own licensing; do not assume all mr.doob work is MIT.
- License discrepancy: Seeing Theory's LICENSE is Apache-2.0 while README asks against commercial visualization use. Distill Momentum's page says CC-BY-2.0 for text/diagrams while its repository advertises CC-BY-4.0. Record these boundaries precisely and prefer fresh implementation unless reusing a clearly licensed artifact.

## Synthesis and verification

- Bruno Simon was the sixth successful hands-on check: clicking the car started the world; ArrowUp and ArrowRight drove it through scene objects, and R produced a transition then returned the car upright. Captured before/after recovery evidence. Top-level icon buttons appeared unnamed in the browser accessibility snapshot. No server messages or multiplayer communication were sent.
- Discovered that the parent had independently chosen the same browser session name. Parent moved to root-inspo; retained creative-research for the remaining local check and will close only that session. This did not change the research claims.
- Read the existing experiment catalog before proposing ports. Prioritized Key & Door, Living Scenes and Music; added Tiny Harbor, Rule Garden and Ghost Brush as the three new priorities, with four follow-on proposals. These are design proposals, not implemented or evaluated demos.
- Key technical distinction: a full world hash changes every tick and cannot be the sole asynchronous response acceptance check. Record it for provenance; validate branch, decision epoch, relevant semantic revision and action preconditions. Candidate futures need recomputation if physical assumptions change.
- Key research distinction: model scores, finite repeat frequencies, known simulation probabilities and provider availability describe different things. Avoid presenting any of them as calibrated confidence without an appropriate evaluation.
- Sources catalog contains 16 works, including one creative coding tool. Six were personally interacted with; the other ten retain documentation-only or blocked status. No durable branch tree was verified in these brief visits; the proposed checkpoint contract is our own synthesis.
- Added a small Bun validator for source/evidence completeness, proposal count and individual screenshot limits. No application files changed and no paid calls were made.
- Validation passed: 16 works, 6 personally interacted, 7 referenced screenshots, 10 proposals. Every referenced screenshot is below 2 MB. Visually checked the retained screenshots and removed two redundant Bruno loading views. Closed the creative-research browser session after inspection; root-inspo was not touched.
