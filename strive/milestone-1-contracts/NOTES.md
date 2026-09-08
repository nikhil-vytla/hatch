# Milestone 1 notes

- Created this work folder before investigation. Scope is additive contracts and acceptance cases only. No commits, network, or changes to existing source modules.
- The authority is `docs/ASTRA_DESIGN.md`, including Amendment 1. Read both before writing implementation code.
- Read the full design and Amendment 1. Use `strive.vnext.contracts` to avoid the existing `strive.contracts` module. Existing source and tests stay untouched.
- Amendment 1 replaces the headline order workload with tau2 telecom, adds the harness boundary and three model identities, and inserts harness qualification after Milestone 3. Refer to later milestones by their design titles to avoid ambiguous renumbering.
- Milestone 1 also names simulator scenarios and a reference study plan. Include pure data for both, with checks for the 60/14/40 split and 2,880 development plus 1,280 audit episodes.
- Tool friction: the git fsmonitor socket is unavailable and optional `.agents`/`.codex` directories are absent. Use read-only git with fsmonitor disabled. Papercut logging was attempted; this repository is not opted in.
- Added frozen records, commands, harness protocol, lifecycle/recovery tables, authored/resolved manifest types, feedback permissions, tau scenarios, and reference campaign data.
- First validation: new source passes strict mypy. Acceptance cases pass: 50 passed, 5 strict expected failures. Full mypy identified a heterogeneous set in one test; add its explicit authority-record type.
- Pure helpers parse supplied TOML text and validate construction only. Resolved configuration parsing checks digest shape, not artifact existence, hash correctness, prices, installed binaries, or actual confinement.
- Preserve uncertainty: settled means known bookkeeping is recorded, not that every usage component is known. Consumption never clears unresolved billing; uncertainty cannot transition directly to consumption.
- Expanded validation: 116 new tests pass, five strict runtime probes remain expected failures, and strict mypy passes all 62 source/test files.
- Kept all generated caches and temporary files in this work folder. Copied existing uv/Deno caches locally for offline validation and put Deno behind `--cached-only`. No downloads or model calls.
- Full-suite startup with ordinary `uv run pytest` panicked inside uv 0.9.18's macOS `system-configuration` crate. `UV_NO_SYNC=1` permits the test runner to start. A standalone `uv build --wheel` reproduces the same panic before package build; proxy environment settings and disabled build isolation did not fix it. No existing tests were edited or skipped to hide this failure.
- The full suite has reached its two packaging tests; both report failures consistent with the standalone uv build panic. Await the complete result before recording final counts.
- Full-suite result: 349 passed, 5 expected failures, 2 failures in 194.18 seconds. Only the two existing packaging tests fail, both because uv exits 101 with the macOS SystemConfiguration panic. The full run collected the earlier 50 new cases; the expanded targeted run has 116 passing cases and the same five expected failures. Strict mypy checks all 62 files successfully.
- Final review: existing tracked files have no diff. New source modules contain definitions and pure validation only. No fetched repositories or copied dependencies are part of the deliverable. Remove generated offline caches/test artifacts before handoff.
