# Ten concrete Jev experiments

These are original proposals, not implemented or measured results. Each gives Jev a bounded semantic judgment while code owns motion, legality and consequences. Use immutable source/protocol hashes, exact candidate identities and the replay contract in [patterns.md](patterns.md). Effort labels compare scope, not delivery promises: small fits an existing renderer; medium needs a new interaction/state model.

## First three ports

### P1. Key & Door → “Show me the plan” — first prototype

**Entry:** A little courier is already walking. Drag a destination card onto it: “Bring the brass key back before leaving.” Moving the card reveals a short ghost path.

**Engine/Jev:** Code owns the grid, inventory, collision and A* movement. At an arrival or objective change, Jev ranks legal subgoals such as inspect shelf, collect visible key, return to start, or exit. Candidate descriptors include only observed evidence and stored memory. Each subgoal maps to a typed action; the model never emits physics or coordinates.

**Failure and fork:** At the first wrong turn, freeze and branch into “same wording, repeat,” “shorter wording,” or “show the missing observation.” Replay the original beside the new route.

**Measure:** Paired goal completion, semantic constraint violations, path cost, decision count and availability on authored maps; compare an explicit goal-rule policy and manual play. Preserve maps where all policies fail. **Scope:** small–medium; reuse `games` and current outcome/route machinery. **Lineage:** [Red Blob A*](https://www.redblobgames.com/pathfinding/a-star/introduction.html), [Trust](https://ncase.me/trust/).

### P2. Living Scenes → “The square at five” — first crowd port

**Entry:** Move a handwritten sign between a café, bench and bus stop; watch a dozen small residents reconsider their next stop.

**Engine/Jev:** Fixed steering, collision avoidance, queues and opening times run continuously. Jev scores destinations from fictional residents' explicit needs, the sign and the places they can see. Ask only on arrival or relevant sign changes; batch independent residents with exact individual evidence. Labels such as “waiting for a friend” carry semantics without pretending to model a real demographic.

**Failure and fork:** A jam exposes queue capacity and chosen intentions separately. Fork the sign wording while preserving scheduled arrivals. Overlay destination changes before showing aggregate traffic.

**Measure:** Constraint adherence and paired destination changes; queue length is a property of this simulation, not evidence of realistic crowd prediction. Compare a declared keyword policy and fixed destinations. **Scope:** medium; reuse `worlds`, start with twelve residents and three destinations. **Lineage:** [Polygons](https://ncase.me/polygons/), [2D Visibility](https://www.redblobgames.com/articles/visibility/).

### P3. Music Arranger → “Conduct one bar” — first audio port

**Entry:** Drag a mood card from “hushed” toward “restless” while a loop keeps playing. Next-bar choices light up ahead of the beat.

**Engine/Jev:** Code generates a bounded set of valid arrangement variants, handles the audio clock and enforces harmony/instrument constraints. Jev ranks those variants against the phrase and existing musical context. Commit only at the declared bar boundary; a late result leaves the existing arrangement playing under the chosen pending policy.

**Failure and fork:** Save a checkpoint before a phrase change. Audition two arrangements with the same motif and clock alignment; show the exact variant difference. Never imply metadata scoring is direct audio understanding.

**Measure:** Rule violations, on-time application, unchanged-repeat agreement, and blinded listener preference with sample counts. **Scope:** small–medium; reuse `music` and its typed decisions. **Lineage:** [Sound](https://ciechanow.ski/sound/), [Comeau's springs](https://www.joshwcomeau.com/animation/a-friendly-introduction-to-spring-physics/).

## First three new experiments

### N1. Tiny Harbor — semantic priorities under visible constraints

**Entry:** A tug circles three docks. Drop an instruction such as “Deliver the chilled parcel before helping the empty boat.”

**Engine/Jev:** Code owns currents, travel times, docking, parcel timers and candidate jobs. Jev ranks jobs from a short manifest and the instruction; an exact scheduler provides a comparator when the priority rules are formalized. Start with kinematic 2D movement, not fluid simulation.

**Failure and fork:** A missed deadline points to the decision that caused it. Fork wording or force another job from that checkpoint, with the same currents and arrivals.

**Measure:** Instruction adherence and deadline outcomes by scenario, plus cost relative to the known scheduler; isolate ambiguous instructions from labeled ones. **Scope:** medium. **Lineage:** [Bicycle](https://ciechanow.ski/bicycle/), [Bruno's world](https://bruno-simon.com/).

### N2. Rule Garden — turn language into a visible local rule

**Entry:** Brush a path through a tiny garden, then choose “Flowers gather near water but leave the path clear.” Watch seeded growth begin.

**Engine/Jev:** Supply six explicit rule cards, each a typed neighborhood predicate with deterministic growth. Jev ranks the cards against the instruction; it does not invent code or plants. Show the winning rule in plain language, then allow a direct card override.

**Failure and fork:** A flower on the path exposes an interpretation error immediately. Fork from the same seed into the runner-up rule; display cells where outcomes differ.

**Measure:** Exact rule selection on authored paraphrases; cell outcomes verify execution, not semantic accuracy. Include deliberately ambiguous phrases and allow ties. **Scope:** medium, Canvas2D. **Lineage:** [Polygons](https://ncase.me/polygons/), [Wayfinder](https://wayfinder.nfb.ca/), [canvas-sketch](https://github.com/mattdesl/canvas-sketch).

### N3. Ghost Brush — a semantic instrument with immediate drawing

**Entry:** Draw a curve and choose “windblown,” “woven,” or a custom phrase. Several small brush samples appear; the next stroke uses the selected one.

**Engine/Jev:** Original procedural brushes render continuously from pointer samples. Jev ranks a finite parameter bank described by inspectable metadata. Apply a response between strokes, preserving the active stroke. Clearly label this as description-based selection unless actual image input is added.

**Failure and fork:** Replay the same recorded stroke through two parameter sets; the user can choose either and keep drawing.

**Measure:** Response stability, parameter validity and blinded preference for prompt fit; the lexical baseline ranks the same bank. No objective aesthetic accuracy claim. **Scope:** small–medium. **Lineage:** [Harmony](https://mrdoob.github.io/harmony/), [canvas-sketch](https://github.com/mattdesl/canvas-sketch). Write original brushes; Harmony's code is GPL.

## Four follow-on candidates

### P4. Intent Undo → “Keep the fireflies, undo the blue”

A pond animates continuously while the user makes discrete edits to lights, plants and paths. Jev ranks recorded edit groups against an undo request; code previews the selected inverse operations and applies them only after confirmation in the demo. Scrub and branch the edit history while the simulation clock continues independently. Compare against tagged deterministic undo and authored intended edit sets; report wrong selections and impossible inverses separately. **Scope:** small–medium, reuse `undo`; checkpoint is the core mechanic. **Lineage:** [Red Blob's internal-state design](https://www.redblobgames.com/pathfinding/a-star/making-of.html).

### N4. The Sign at the Fork

Type a short sign beside a fork in a toy delivery track. Jev selects among explicit route-permission interpretations; code handles vehicles, signals and travel. An ambiguous sign produces split interpretations that can be replayed as separate branches, with exactly the same arrivals. Compare paraphrase consistency and declared interpretation labels; travel time remains a simulated consequence. Avoid presenting the result as real traffic or safety guidance. **Scope:** medium; shares routing code with P1 and N1. **Lineage:** [Setosa's validation](https://setosa.io/ev/markov-chains/) and [Bruno's physical exploration](https://bruno-simon.com/).

### N5. A Mobile That Feels Quiet

Hang one object on a mobile and describe the desired feeling. Jev ranks prevalidated arrangements against “quiet,” “playful,” or a richer brief; deterministic torque and damping show the movement. Hard feasibility is computed before semantic ranking. Fork the selected arrangement from identical angles and velocities, then compare settling time separately from human aesthetic preference. The exact physics solver is the validity baseline; a keyword ranker is the semantic baseline. **Scope:** medium; small 2D model before any 3D assets. **Lineage:** [Bicycle](https://ciechanow.ski/bicycle/) and [spring controls](https://www.joshwcomeau.com/animation/a-friendly-introduction-to-spring-physics/).

### N6. The Message Relay

Release a short authored message into a visible network. At each hop, Jev chooses among a fixed bank of paraphrases under a supplied tone constraint; code routes tokens and records the resulting lineage. The user can stop at the first meaning change and fork with a different candidate. Compare preservation of authored facts and sentiment constraints, using the same graph and message set; clearly separate model paraphrase selection from any claim about human belief spread. No free-form message generation is required. **Scope:** medium. **Lineage:** [Trust's staged counterexamples](https://ncase.me/trust/) and [Markov state diagrams](https://setosa.io/ev/markov-chains/).

## What to build first and what would change the recommendation

Start with P1 to settle the state, late-answer and branch contracts; P2 then tests simultaneous agents against those contracts. P3 verifies that action boundaries also work when timing is audible. Prototype N2 before N1 or N5 if the goal is the fastest new semantic experiment: its rules have precise authored labels and its renderer is simple. N3 is the strongest small creative tool; N1 is the strongest new game-shaped systems test.

The user's pending choices about late answers, game versus crowd emphasis, and branch scope may reorder these, but do not change the need to separate deterministic movement, semantic decisions and immutable replay. No proposal requires a model call every frame, hidden owner-key access, new model training, or generated assets before it can answer its design question.
