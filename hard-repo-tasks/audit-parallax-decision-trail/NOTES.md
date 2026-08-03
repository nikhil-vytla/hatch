# Parallax decision-trail audit notes

Scope: audit `autoresearch/decisions.tsv` against the active transcript and cited artifacts. Preserve append-only history, do not modify production source, and do not commit.

## Work log

- Started by defining the audit scope and creating this isolated work folder.
- Read all 82 original decision rows. Audited TSV lines 68-83 in full and
  spot-checked the earlier synthesis, calibration, containment, deployment,
  table-last, and replay correction chains.
- Targeted only the active transcript. Lines 593-595 record the research-harness
  reframing and architecture delegation. Lines 624-627 record the formal-model
  and literature delegation. The allowed transcript does not contain the
  subordinate agents' completion actions, so the documents prove outputs but
  direct action provenance remains incomplete.
- Verified Unit 0 against `receipt.json`, `transcript.txt`, and
  `artifact-digests.json`. The build and replay each exited zero, returned the
  same family and arm IDs, and preserved matching digests for seven files.
- Verified the SCBench `v0.2` tag and commit through both cited GitHub API
  endpoints. They currently resolve to
  `bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1`.
- Found one material missing correction. The accepted synthesis-kernel row
  predates the explicit finding that the current path consumes a handwritten
  proposal, accepts placeholder provenance digests, and appends the complete
  source question. Appended a correction to retain only the artifact lifecycle
  and locked-replay claim.
- At audit time, the architecture files named Candidate D as the accepted base
  and rejected Candidates B and C, but the canonical log had no selection row
  and the active transcript ended before that selection completed. The
  follow-up used the surviving arena files and cross-judge record rather than
  manufacturing provenance.
- Evidence weaknesses to retain for review: the scheduler-overlay row points to
  derived prose rather than captured pinned source; the SCBench resolution has
  live links but no immutable API receipt; Unit 0 embeds deleted scratch paths
  and records only `repository_head`, not the dirty worktree state.
- Repeated correction/evidence pairs at lines 52/57, 53/58, 55/59, and 56/64
  preserve history but add reading overhead. The Qwen interpretation also
  appears at lines 47, 52, 57, and 63. Do not rewrite them under append-only
  semantics.
- Follow-up proof `unit0-family-build-provenance-20260802` retained base HEAD
  while binding 27 exact current input files, relevant git status, and the
  tracked-diff digest. It reproduced the original family and arm IDs and
  byte-identical seven-file build/replay trees.
- Deliberate early failure `unit0-family-build-failure-20260802` retained only
  its failure receipt, transcript, stdout, and stderr before scratch cleanup.
- Preserved the four arena candidate digests and cross-judge outcome in
  `architecture/evolving-intent-pipeline/DESIGN-SELECTION.md`.
- Corrected the stale calibration interpretation and synthesis-kernel summary.
  Production findings in `src/parallax` remain open and were not changed.
- Verified all four surviving arena candidates against the SHA-256 values in
  `DESIGN-SELECTION.md`, then copied the exact bytes into the local `arena`
  directory. Preserved the cross-judge's final scorecard and disposition in
  `arena/judge.md` without copying JSONL metadata or tool chatter.
- Verified the Microsoft Evolving Intent checkout at
  `993d6be9597ac03854b46362ccd647eb1bfd267a`. Recorded immutable links, Git blob
  IDs, SHA-256 content hashes, and the relevant SWE overlay ranges in
  `characterization/UPSTREAM-SWE-OVERLAY.md`.
- Appended one grouped canonical decision for the five production gates. No
  production source was changed.
- Validation found 91 well-formed TSV rows, no formula prefixes or duplicate
  decisions, and no unresolved local paths or anchors. Authored Markdown is
  whitespace-clean. Candidate C's exact source bytes contain nine
  trailing-space lines, which remain unchanged to preserve its recorded hash.
  Upstream, candidate, transcript, and local judge hashes and
  `git diff --check` passed.
