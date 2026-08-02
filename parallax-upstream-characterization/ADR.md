# ADR: characterize upstream before implementing it

Status: accepted for the clean-stack sequence.

## Decision

Microsoft Evolving Intent commit
[`993d6be9597ac03854b46362ccd647eb1bfd267a`](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a)
is a characterization oracle, not a production dependency. Production code in
later PRs must be implemented from first principles and compared with the
receipt in this folder. Imported upstream records may be source-digested test
evidence, but they cannot become production families without real generation
provenance.

The upstream code uses these terms:

- "function + argument extraction" in `BaseExtractor`
- "Argument Counterfactual" in `CounterfactualGenerator`
- "Function Predecessor" in `PredecessorGenerator`
- "plan-first turn scheduler" in `turn_scheduler.py`
- `ChangePlan`, `UserIntent`, and `IntentTransition` for trajectories
- "SWE-bench Verified-specific scheduling overlay" in
  `turn_scheduler_swe.py`

Parallax must not rename a partial analogue to "Evolving Intent" and imply
equivalence. A compatibility claim needs exact source hashes, structural
scheduler parity, and deterministic-prefix render parity at this pin.

## Source-grounded invariant

For an accepted upstream Stage 3 record with enough predecessors and argument
counterfactuals:

1. `select_functions` reverses the stored nearest-first predecessors so the
   conversation begins with the farthest predecessor.
2. In evaluation mode, `select_counterfactuals` selects revisions round-robin.
3. `create_sample` requires at least `1 + actual_g + actual_p` turns, then runs
   schedule, argument fill, text fill, rendering, and `ChangePlan`
   construction in that order.
4. A correction chain advances through later counterfactual variants and ends
   at the source argument.
5. Rendering orders content within a turn as function, correction, then
   reveals.
6. The final `UserIntent` restores the source function, source argument
   values, all source argument IDs as revealed, and the source label.
7. The SWE wrapper removes `category == "symptom"` arguments before the
   generic scheduler. Its `post_fill_hook` repairs ownership, redistributes
   within each phase, reinserts symptoms, and then sorts arguments. At this
   pin, stripped symptom IDs lack category entries during the final sort and
   render after recognized categories.

The receipt mechanically exercises items 1, 2, 3, 5, 6, and all behavior
described in item 7. Exact source hashes and static symbol checks cover the
provider-backed stages and item 4. Provider outputs are not available, so this
ADR does not claim that any published conversation was recreated.

## Frozen construction boundary

Extraction, generic argument counterfactual generation, predecessor generation,
naturalization, and optional judge paths call models. Their accepted requests,
responses, parses, validation failures, parameters, and model identities would
need to be frozen before deterministic compilation. Upstream does not publish
that evidence bundle.

`Compile(FrozenConstruction)` must make no provider call, fetch no mutable
asset, and consume no clock or mutable batch counter. This is a Parallax
requirement for later PRs, not a claim about the pinned upstream repository.

## Consequences

- This PR records behavior and unavailability. It adds no synthesis API.
- Prefix parity uses injected deterministic prefix functions. Upstream's
  mutable evaluation prefix counters are observed behavior, not a design to
  copy.
- Final native evaluation does not validate intermediate turns.
- Byte-identical reproduction is out of scope because generated datasets,
  provider snapshots, dependency locks, and paper result bundles are absent.
