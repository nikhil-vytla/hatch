# Playable implementation notes

- Existing crowd already has branch snapshots, cancellation, resident intent checks, live/recorded provenance and fallback counters. Changes can reuse this engine instead of introducing another state model.
- Existing music already has phrase locks, note editing, bar-boundary score changes, JSON and MIDI export, and a generation counter protecting asynchronous requests. Focus new work on explicit continuity checks and blind listener preference records.
- A broad text search accidentally included large recorded JSONL files. Subsequent searches are restricted to TypeScript. The papercut CLI refused to log because this repository has not opted in; no log file was created.
- Crowd notices are editable directly under each scene. Editing cancels that lane's pending request. Reset, branching and recorded replay clear unposted inline drafts.
- Added a same-state notice comparison that copies the selected lane before changing only notice text under a shared policy. The UI lists per-resident route differences and allows inspection of that resident's actual recorded request/typed reply.
- Music continuity filters candidate melody intervals at both neighboring phrase boundaries. If no candidate qualifies, the UI reports that condition and does not broaden the limit automatically.
- Music A/B auditions randomize source order, hide sources until a preference is recorded, use the existing equal-gain player, and export local listener records. Playback-start checks do not verify listening duration; records are explicitly personal preferences, not objective quality scores.
- Added browser score save/restore while retaining existing JSON/MIDI exports, phrase locks and bar-boundary scheduling.
- New crowd tests: 2 passed. New music tests plus existing music engine suite: 12 passed with 10,768 expectations. App TypeScript compilation passed. Root integrator owns browser review.
- Rotated to independent routing review as assigned. Identified redirect locality bypass, cancellation during verification, pre-cap classifier invocation, and malformed MCP-null handling. Routing owner fixed these before provider-free probes executed. Saved passing post-fix evidence and reproduction code under `review/`.
- Sent follow-up review notes on classifier cancellation, cached-token upper bounds and malformed costs. Classifier-comparison quality evidence is not established by a metadata-only classification record.
- A repeat app compilation later found Bun types missing in newly integrated routing web imports; playable files remained clean. Routed that build issue to root and routing owner.
