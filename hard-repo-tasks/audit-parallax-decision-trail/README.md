# Parallax decision-trail audit

## Scope

Audited all 82 pre-audit decisions, with full review of TSV lines 68-83 and
spot checks of the earlier synthesis, calibration, containment, deployment,
table-last, and replay corrections. The audit used only the named active
transcript, the architecture files, the Unit 0 receipt set, and evidence paths
from the decision log.

## Verdict

The recent trail is mostly faithful if lines 68-78 and 80-83 are read as
architecture and evidence decisions, not implemented production capability.
Every local evidence path resolves. Unit 0 directly proves one CLI family build
and locked replay from a hand-authored proposal. It does not prove Microsoft
generation, upstream parity, provider behavior, HUD rollout, external assets,
or checkpoint execution.

Direct transcript provenance is incomplete. The active transcript records the
delegations that requested the architecture, formal model, and literature work,
but it ends before the subordinate completion actions. The resulting artifacts
exist and support the decisions, but the allowed transcript alone cannot show
who made each exact edit or when it completed.

## Rows checked

- Lines 68-77 map to the research-harness reframing and architecture delegation
  in active transcript lines 593-595. Their evidence describes proposed
  architecture and explicitly says the API is not implemented.
- Line 78 records a real correction to the SWE scheduler description. The
  wording is consistent across the architecture files, but its evidence points
  to derived prose rather than captured pinned upstream source.
- Line 79 is supported by the Unit 0 receipt, command transcript, and complete
  artifact digest manifest. Both commands exited zero and emitted the same
  family and arm IDs. Seven build files match seven replay files by digest.
- Lines 80-81 map to the formal-model delegation in transcript lines 624-627
  and are bounded correctly in `FORMAL-MODEL.md`.
- Line 82 is currently correct. Both cited GitHub API endpoints resolve SCBench
  `v0.2` to `bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1`. No immutable copy of those
  API responses is retained with the project.
- Line 83 is an architecture choice, not proof of full-loop verification. The
  actual skill exists, but only the frozen-family feature has a complete
  receipt in the reviewed evidence.

## Correction appended

Appended TSV line 84 to supersede the interpretation of the synthesis-kernel
slice as an Evolving Intent implementation. The current compiler consumes
prewritten event messages and appends the full source question. The valid
surviving claim is artifact lifecycle and locked replay; algorithmic generation
remains open.

## Original issues and current status

1. **Closed in follow-up.** The four candidate digests, cross-judge record,
   selected base, grafts, and rejections are preserved in
   `architecture/evolving-intent-pipeline/DESIGN-SELECTION.md`, with a
   canonical decision row.
2. **Closed for the new run.** The original Unit 0 receipt remains historical
   and incomplete. The new receipt binds exact dirty-worktree bytes while
   retaining base HEAD.
3. The scheduler-overlay correction and SCBench source pin rely on prose or
   live links. Consider immutable characterization receipts before using them
   as implementation gates.
4. Lines 52/57, 53/58, 55/59, and 56/64 are correction plus evidence-pointer
   pairs. The Qwen correction is spread across lines 47, 52, 57, and 63. Keep
   them for append-only history, but treat them as one chain each rather than
   independent findings.
5. The result text on line 74 can sound broader than Unit 0. Only one mapped
   feature was driven end to end; the receipt explicitly excludes native HUD
   rollout and upstream characterization.

## Follow-up provenance correction

The new Unit 0 proof keeps the original evidence intact and adds a separate run
whose receipt binds base HEAD, relevant git status, the tracked-diff digest, and
every relevant current input by relative path and SHA-256. This proves which
dirty-worktree bytes produced the artifacts, including untracked source files.
It does not upgrade the proposal's provenance: the proposal remains
hand-authored, contains placeholder digest-shaped strings, and has a
`school_supply_sales` versus Natalia's clips mismatch. The corrected claim is
artifact determinism only.

Failed proof attempts now publish only their transcript, captured stdout/stderr,
and a small failure receipt before scratch removal. They do not publish partial
stores, caches, credentials, or other scratch contents. The architecture arena
selection and candidate digests are preserved in
`architecture/evolving-intent-pipeline/DESIGN-SELECTION.md`.

## Open production gates

These findings remain open. This documentation-and-proof unit did not modify
production code or claim they are fixed:

- **Overstated in-process admission evidence:** `src/parallax/kernel.py`
  describes an independent frozen-input compile although the in-process check
  reuses parsed objects. The locked CLI replay is the stronger proof.
- **Verifier implementation is not identity-bound:** `src/parallax/gsm8k.py`
  hashes an evaluator label and answer authority, not the parser/scorer
  implementation.
- **Lenient GSM8K parsing:** `src/parallax/gsm8k.py` falls back to the last
  number anywhere in a response, weakening invalid-submission detection.
- **Matched sealed identity coupling and string-only event payloads:**
  `src/parallax/kernel.py` includes the evolved proposal in matched sealed
  identity and drops non-string event fields from the sealed event payload;
  the related event model is in `src/parallax/evolving_intent.py`.
- **Contaminated lifecycle fixture:** `tests/fixtures/synthesis_kernel/gsm8k.json`
  uses the famous GSM8K `test:0` Natalia example. It may remain a lifecycle
  fixture but must not support a measurement claim.

## Validation

`audit_tsv.py` reports 90 data rows after the follow-up corrections, the exact six-column
header, no malformed rows, no timestamp errors, no spreadsheet-formula
prefixes, no unresolved local evidence paths, and no duplicate decision text.
`git diff --check` passes. No production source was modified and no commit was
created.

## Follow-up closure note

H3, the architecture-arena durability finding, is fully durable after local
preservation. The exact Candidate A through D bytes and a concise copy of the
cross-judge's final decision now live under
`architecture/evolving-intent-pipeline/arena/`; `DESIGN-SELECTION.md` links
those files and retains every original provenance hash. The SWE half of
original issue 3 now has a separate pinned-source characterization with
immutable GitHub links, Git blob IDs, SHA-256 content hashes, and exact source
ranges.

The five reviewed production issues remain open. One append-only row, TSV line
92, links the canonical decision log to [Open production
gates](#open-production-gates), so all five are reachable without five
duplicate decisions. This follow-up adds evidence and reachability only. It
does not erase or upgrade the original review history.

Follow-up validation found 91 data rows with the exact six-column header, no
malformed rows, timestamp errors, spreadsheet-formula prefixes, duplicate
decision text, or unresolved local paths and anchors. All newly authored
Markdown has a final newline and no trailing whitespace. Candidate C retains
nine source-original trailing-space lines because changing them would violate
its required SHA-256. The upstream HEAD, both upstream blob IDs and content
hashes, all four candidate hashes, both judge hashes, and `git diff --check`
passed. This follow-up did not edit production source; pre-existing source
changes in the working tree were left untouched.
