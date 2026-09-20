# Extensions worth building after the repairs

These are proposals, not implemented experiments or measured improvements. They reuse the app's existing decision interfaces and expose an outcome a visitor can inspect. The primary-source links below establish library capabilities; the Jev integrations are our designs.

## A canvas that understands the edit

Use [tldraw's editor](https://tldraw.dev/docs/editor) to build a working diagram editor. The visitor says, "Group the things I need before launch, but leave the optional ideas alone." Jev labels selected shapes with group membership and chooses a layout intent. Code computes geometry, preserves locked shapes, previews the transaction, and makes the accepted change one undo step. A stronger follow-up changes a deadline and highlights the affected dependency chain.

The useful test is whether grouping matches the user's intended meaning while preserving every unrelated shape. Compare Jev against keyword grouping and a full generative-model edit on the same 200 independently annotated requests. Include ambiguous and conflicting edits, and measure accepted edits, correction effort, latency, and unintended mutations. This extends intent-based undo, change impact, and generative interfaces into one real application. Check [tldraw's production licensing](https://tldraw.dev/community/license) before adopting it; do not assume every library is deployable under the same terms.

## A document editor that pastes the right structure

[Tiptap commands](https://tiptap.dev/docs/editor/api/commands) can insert content, change document nodes, and combine changes into transactions. Build a two-pane editor with a source article and a destination brief. Jev selects source spans and a supported transformation such as contact card, comparison table, citation, or checklist. Code preserves exact quoted facts, validates the destination schema, and presents a reversible preview. The visitor can ask "Keep the dates, remove the sales copy" and inspect which spans survived.

Evaluate against ordinary paste, deterministic HTML-to-schema conversion, and a larger-model transformation. Use complete documents with repeated names, stale dates, nested tables, and unsupported fields. Score source fidelity separately from formatting preference. This tests semantic paste with a real editing model rather than a handful of prepared fields.

## A workshop full of small actors

[XState actors](https://stately.ai/docs/actors) provide event-driven state and bounded lifecycles. Give a visitor a small workshop with customers, machines, stock, and deadlines. Jev interprets each worker's immediate situation and selects among legal actions or requests clarification. The state machine executes the action, owns inventory and time, and cancels obsolete decisions when conditions change. A visible event rail shows the difference between a worker's intent and the resulting world state.

Start with Café Jev, then reuse the same system for a repair shop or transit desk. Compare against first-in-first-out, shortest-job-first, and scripted preference rules across a fixed 500-seed suite. Introduce stockouts, changed orders, conflicting deadlines, and interrupted requests. Measure completed valid orders, unnecessary questions, lateness, and fairness. A success animation fires only after the simulator confirms completion.

## A data notebook with inspectable semantic columns

[DuckDB-Wasm](https://duckdb.org/docs/current/clients/wasm/overview) provides browser SQL over local data, including CSV, JSON, and Parquet. Pair it with the existing TanStack Table view. SQL first selects eligible rows. Jev adds semantic labels with cited text spans, abstentions, and an input/schema fingerprint. The visitor corrects a few rows and sees whether a revised question changes only affected results. Aggregations remain ordinary SQL over explicit labels.

The experiment is whether semantic filtering reduces review effort without hiding false negatives. Use a separately annotated 1,000-row corpus with duplicate threads, negation, resolution messages, and irrelevant boilerplate. Measure precision, recall, reviewed rows, and correction time against lexical filtering and an embedding baseline. Browser-local SQL does not make hosted Jev inference local; show the selected outgoing text before a live run. This extends semantic spreadsheet, active labeling, and change impact together.

## A game director with actual choices

[React Three Rapier](https://github.com/pmndrs/react-three-rapier) adds physics bodies, colliders, and events to React Three Fiber scenes. A rescue game can use these for moving obstacles, doors, carried objects, and timed hazards. Jev should pick semantic subgoals and react to changed instructions. A local planner handles movement and collision avoidance. Show three controllers on the same seed: planner alone, Jev alone with legal actions, and Jev directing the planner.

The interesting instruction is "Rescue the fragile cargo first, avoid the lit corridor, then return if fuel gets low." The comparison must vary the instruction while holding the map fixed. Measure independently checked instruction satisfaction, resource use, and recovery after a changed goal across 100 maps and multiple goal variants. This is a stronger test of Jev's value than adding visual complexity to a route a greedy rule already solves.

## An adaptive score that follows the world

The music redesign can become a soundtrack engine for Café Jev or Orbital rescue. [Tone.js](https://tonejs.github.io/) schedules playback; [Tonal](https://github.com/tonaljs/tonal) supplies theory and voicing operations. Jev selects section energy, instrumentation, motif transformation, and the next harmonic direction from typed candidates. Code expands those choices into valid score events, schedules transitions at phrase boundaries, and derives the piano roll and MIDI export from the same events.

Give visitors an A/B switch between fixed music, a rule-based adaptive score, and Jev's interpretation of the same event timeline. Blind listeners rate coherence and fit, while code measures dropped notes, clipping, off-beat transitions, repeated contour, and event/export agreement. Save actual Jev decisions alongside the soundtrack. No simulated model output should be labeled as a measured Jev run.

## Where to start

Repair the score representation and build Café Jev first. They expose the difference between semantic choices and executable outcomes in ways visitors can hear and see. Then combine the paste, undo, and change-impact work in a document or canvas editor. The notebook and game director are good later experiments because they reuse evaluation and simulation infrastructure instead of creating another isolated demo.
