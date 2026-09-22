**Verdict:** Sound and carefully hedged. The audit text, the JSON/flat/native distinction and the recorded-vs-proposed labelling are internally consistent (R2 arithmetic checks out; every repeated evidence hash agrees across records). The fingerprint guard is correctly ID-bound. Remaining problems are a data-model seam that drops information, one over-simplified public sentence, and a mobile legibility defect.

## Findings

**1. Question counts are silently dropped for half the records (confirmed).**
`build-atlas.py:21-27` only derives `count_note` when `primitives` is a list. Tooling/training records were authored with string primitives, so they ship `count_note: ""`, and both renderers print only `count_note`, never `count` (`atlas.js:15`, `capability-inspector.tsx:44`). Lost on screen: latency's `[1, 8, 32, 128]` (`atlas.json:1029-1034`), micro's `"16 search / 8 drink / 3 unsupported"` (`atlas.json:806`), rewardbench2's `"up to 128 under 90 KB"` (`atlas.json:1291`). The same seam produces mixed vocabulary in the UI ("Choice + Noul" at `atlas.json:295` vs "1 four-verdict choice" at `:657`). Normalize at build time and render `count` when `count_note` is empty.

**2. Public essay says "reject"; the audit's key finding is silent loss (confirmed inconsistency).**
`build-atlas.py:58,69` state wrappers "block"/"reject" structured criteria. `runtime-audit.md:28` (R1) says hosted validators reject, but the shared `validateRequest` and Mac `validate` *accept* an extra `criteria` object and drop it, answering a weaker question with no unsupported state. The audit calls this the more dangerous behaviour; the visual omits it. One extra clause in the essay would fix this.

**3. Mobile comparison is clipped (confirmed by screenshot).**
`atlas.css:55` uses `white-space:pre; overflow:auto`. In the mobile screenshot both samples truncate mid-string ("Fixes only the requested", `"excludes": ["a test needed for the fix"` cut), so the exact content that distinguishes flat from native is off-screen with no scroll affordance. Use `pre-wrap` or shorten the example lines.

**4. Inspector does not show execution mode (gap vs `decision.md:25`).**
`capability-inspector.tsx:35-56` renders input, questions, code effect, distribution use, recorded evidence and next study, but not `execution_modes`. A reader on an experiment page cannot tell from the inspector whether that page replays recordings, calls BYOK live, or runs local code. The atlas page does show modes (`atlas.js:17`) but as an undifferentiated ` · ` list of free text with no recorded/live/local typing. Suggest a small typed field (`recorded | live | local | proposed`) rendered in both places.

**5. Fingerprint boundary: correct as far as it goes; scope and staleness are unstated (partly unverified).**
What works: `prepare-atlas.ts:21-24` requires wiring bindings *and* every record evidence hash; missing files hash to `null` → false. `capability-inspector.tsx:8-9` discards a status stored for a previous `id`, and the effect aborts on id change. Gaps:
- `tsx:18` compares `body.auditDate` to `atlas.audited_at`, both constants from the same file, so it cannot detect a stale `capability-build.json` from an earlier deploy or a cache. Nothing ties the fetched JSON to the running bundle. Whether this matters depends on the build pipeline, which is not in the snapshot — embed a build id in both to close it.
- "matches" means "listed call sites unchanged", not "every sentence verified". Example: `ui` claims "The browser gateway rejects nested question instructions" (`atlas.json:117`) but gateway.ts is not in that record's evidence (`:126-147`). The summary label should say what is guaranteed.

**6. Minor code notes.**
- `build-atlas.py:57` hardcodes "41 entries" although the count is computed at `:111`.
- `atlas.css:65` reduced-motion block is dead: no transitions/animations exist. Harmless.
- `atlas.js:14,42`: two `aria-live` regions update on every keystroke; potential verbosity — not verified.
- `capability-inspector.css:16` hardcodes focus `#ad6e0a`; atlas dark mode uses `#e9b660`. Contrast on a dark host theme is unverified.
- `tsx:13` `setStatus("checking")` inside the effect is redundant given the derivation at `:9`.

**7. Unverifiable references.** `documentation-sources.json` (`docs-research.md:3`), probe scripts/results (`runtime-audit.md:62-69`), `training-audit.json` (`:42`) and `IMPLEMENTATION.md` (`decision.md:27`) are not in the snapshot; claims resting on them are taken as stated, not confirmed.

## Worth keeping

- The four-step INPUT → QUESTION → CODE USES → EVIDENCE flow and the separate "Go deeper here" block: they make recorded, live and proposed visually distinct on desktop.
- Explicit hedges throughout: "interface example, with no model result attached", "These are proposed studies", per-record "not … evidence" sentences, `docs-research.md:3` "provider interface claims, not measurements".
- R2's worked example (probabilities `[0.1,0.2,0.7]` → Score 1.6 vs argmax 30 / mean 26) — concrete and correct.
- Build hygiene: `<`/U+2028/2029 escaping in embedded JSON (`build-atlas.py:44`), `escape()` on all interpolations (`atlas.js:6`), hash deep-links with `replaceState`, focus restoration after re-render (`atlas.js:28,45`), ≥44px targets, `:focus-visible` outlines, `minmax(0,1fr)` grids on mobile.
- The inspector hiding all role claims (not just some) when status ≠ matches, and the hash cache in `prepare-atlas.ts:10-19`.
