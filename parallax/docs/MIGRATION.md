# Migration ledger from the evidence branch

This ledger records architecture learning from
`cursor/hard-repo-tasks-5fc8`. It does not copy arena candidates or make that
branch part of this PR.

## Accepted

- `src/parallax/ids.py`, canonical bytes, content-derived IDs, source pins,
  public and sealed commitments, and atomic publication are sound lifecycle
  building blocks. They belong to PR2, not this PR.
- Native verifier authority and typed grading outcomes remain required.
- Frozen stochastic construction followed by provider-free deterministic
  compilation remains the boundary.
- Structural scheduler parity is the primary source gate. Exact text parity is
  limited to deterministic injected prefixes.
- Domain adapters should be explicit constructor inputs. A closed domain enum,
  import-time discovery, or global registry is not accepted.
- Failed construction attempts need a closed failure classification and must
  retain parsed rejected records. Billing, timestamps, and provider request IDs
  are audit data, not semantic identity.

## Superseded

- `architecture/evolving-intent-pipeline/FORMAL-MODEL.md` and `ADR-001.md` are
  superseded for the clean stack by the smaller invariant in
  `adr/0001-upstream-characterization.md`. The old documents mixed this source
  characterization with later research protocol, checkpoint evolution, and
  experiment design.
- The old Unit 0 family-build receipt is superseded as an Evolving Intent gate
  by `../characterization/fixtures/receipt.json`. Its valid locked-build result
  remains historical evidence for artifact determinism.
- The prose-only SWE correction is superseded by the executable source and
  overlay checks in `../characterization/characterize.py`.

## Negative evidence

- `parallax.frozen-proposal.v1` is not a Microsoft Evolving Intent
  implementation. `ProposalBundle.load` accepts caller-supplied strings that
  merely look like SHA-256 digests. The checked fixture uses repeated `a` and
  `b` placeholders, so it has no provider provenance.
- The fixture's `school_supply_sales` value is unrelated to the pinned GSM8K
  source question about Natalia selling clips. Admission did not detect the
  semantic mismatch.
- `compile_plans` turns authored `Reveal`, `Revise`, and `Switch` messages into
  precursors, then appends `source.question` verbatim as the final turn.
  Upstream instead selects real extracted functions and arguments, schedules
  predecessor and correction events, fills reveals, renders deltas, and builds
  a `ChangePlan`. The old path executes none of extraction,
  `CounterfactualGenerator`, `PredecessorGenerator`, `schedule_events`,
  `fill_arguments`, `fill_texts`, or `render_turns`.
- `replay_plan` proves only that the authored event goal reaches the literal
  sentinel `answer_source_task` and that the appended question matches the
  anchor digest. It does not prove source-function restoration, source-argument
  restoration, reveal deadlines, correction-chain order, predecessor order,
  or renderer parity.
- Byte-identical family replay on that fixture proves deterministic output for
  those exact invalid inputs. It does not establish generation provenance,
  semantic validity, upstream parity, provider replay, or paper-result
  reproduction.

## Deferred hypotheses

- A content-addressed production construction ledger can bind provider
  exchanges and accepted Stage 3 records without importing upstream runtime.
- GSM8K can become the first real domain once recorded provider calls and
  native verifier gates exist.
- BIRD-SQL, BrowseComp+, and SWE-bench can reuse a later core only if their
  external databases, corpora, indexes, images, and evaluator versions become
  identity-bearing inputs.
- Mutable prefix counters should probably be replaced by sample-local
  deterministic state. That is an intentional divergence to decide in a later
  implementation PR.

## Rejected implementation

- Do not migrate `ProposalBundle`, `Reveal`, `Revise`, `Switch`,
  `compile_plans`, `_matched_turns`, or the `EvolvingIntent` class name as the
  production implementation.
- Do not migrate the universal variant algebra, bespoke SWE schedules,
  checkpoint placeholders, synthetic campaign API, HUD adapters, Click
  recipes, or experiment runners into this clean stack unit.
- Do not convert placeholder digests into apparently valid provenance.
- Do not use a hand-authored Stage 3 record as an upstream parity gate.
- Do not add a compatibility read path for `parallax.frozen-proposal.v1`.
