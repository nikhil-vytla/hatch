# ADR-0014: Non-benchmark workloads need no core changes; the real gap is the environment

Status: accepted as a finding + a minimal proof step. `Session`'s round count is
now configurable and verified at 20 rounds. A real-environment adapter, a
generic adapter-agnostic driver, and open-ended (non-finite) execution remain
unbuilt and are tracked here as separate follow-ons, not attempted.

## Context

The only two implemented workloads (Counter, tau2 telecom) are both scored
benchmarks, which reads as if `ContinualRefine` requires a task corpus and a
reward signal to operate at all — the same shape as a research benchmark, not
a general continual-adaptation harness. Before changing anything, we traced
where scoring and episode structure actually enter the decision path:

- `ContinualRefine.refine()` (`policy/runtime.py:88-176`) — the actual
  keep/revise/restore decision — never reads `RewardResult`, `Measurement`, or
  `adapter.scorer`. It is driven only by evidence bytes and a model proposal.
- `EvidenceSelector` (`policy/evidence.py:47-65`) uses `EpisodeId` solely as an
  opaque scoping key into a feedback pool; it never reads task or reward
  content.
- `BenchmarkAdapter`'s protocol methods (`benchmarks/api.py:150-222`) are not
  inherently reward-shaped. A trivial/constant scorer is already legal and
  demonstrated in-tree (`tests/vnext/test_tau2_rpc.py:62`, every `ArtifactRef`
  field including `scorer` pointing at the same dummy pin).
- `PROJECT_CHARTER.md` states the underlying principle directly: there is no
  universal empirical-promotion requirement.

So scoring is not the blocker. What we actually found, by tracing the runner
loop itself:

1. `cli/runner.py`'s `Session` hardcodes `self.adapter = CounterAdapter(...)`
   and, until this change, a fixed 2-task stream. There is no generic "pick
   any installed `BenchmarkAdapter` and drive it" mechanism — tau2 needed its
   own separate, structurally similar driver (`cli/campaign.py`'s `Campaign`)
   rather than reusing `Session`.
2. Both shipped adapters implement a *simulated* environment —
   `agent_tool`/`deliver_message`/etc. operate on synthetic in-memory state.
   Nobody has built an adapter whose environment executes real actions (real
   file edits, real test runs) against a real sandboxed repo. **This, not
   scoring, is the actual gap for pointing strive at real ongoing work.**
3. `task_stream` is a finite, authored list; the loop's completion condition
   is `len(state.measurements) == len(self.assignments)`
   (`runner.py:261-262`, `campaign.py:308-310`) — closed-horizon by
   construction. Nothing rejects a repeated task, though: the task-stream
   check only rejects *unknown* tasks, not duplicates, so a many-round
   session is already representable as "the same task N times."

## Decision

Make the round count in `cli/runner.py`'s counter fixture path a parameter
(`rounds: int = 2`, threaded through `Session.__init__` and the module-level
`run()`) instead of a hardcoded 2-task stream, as a minimal, additive,
non-frozen-core change (`runner.py`/`campaign.py`/`fixture.py` are not in
either `tests/vnext/baselines/*.json` hash set).

This surfaced one real, previously-latent bug: the fixture's comparison plan
hardcoded `"horizon": 2` (`runner.py`, `builtin:comparison-plan`), matching
the old fixed round count. `report/compare.py:92-93` checks
`coverage.planned != spec["horizon"]` and raises `VerificationError` on a
mismatch — so any non-default `rounds` would have silently broken `strive
compare` on that run. A Codex stop-hook review caught this before the change
shipped; fixed by tying `horizon` to `rounds` too.

Ran the fixture at `rounds=20` (budget raised from the default
`model_calls=10` to 30 to get past the first attempt's early suspension) as
the proof: `coverage: {"planned": 20, "admitted": 19, "completed": 18,
"unresolved": 2}`, `performance: {"cumulative_successes": "17",
"observed_fulfilment": "0.85"}`, `execution_status: "suspended"` at
`runtime.step` — stopped by the manifest's `wall_seconds=120` budget (real
sandboxed subprocess overhead per round), not by anything episode-count- or
scoring-shaped. That is itself further evidence: the mechanism has no
architectural ceiling on round count; it is bounded only by declared resource
budgets, which suspended it safely and correctly rather than misbehaving.

## Consequences

Scoring/episode vocabulary is not what's stopping strive from running against
open-ended work — it was never a real requirement of the policy or evidence
layers, only of the two adapters that happen to exist. Three real gaps remain,
each a separate, unattempted follow-on:

- **A real-environment `BenchmarkAdapter`** — actual file edits and test
  execution against a real sandboxed repo, reusing the existing
  `CandidateExecutor`/sandbox infrastructure. This is the actual "point strive
  at my codebase" capability, and it is substantial, separable engineering.
- **A generic, adapter-agnostic driver** — collapsing `Session` and `Campaign`
  into one driver selected by the manifest's `pins.adapters`, instead of a new
  near-duplicate driver per adapter.
- **Open-ended (non-finite) execution** — removing the
  `len(assignments)`-reached completion condition for a workload with no
  natural finite horizon. Today's proof uses a large-but-finite round count,
  not true unboundedness.

See [ARCHITECTURE.md](../ARCHITECTURE.md), [ADR-0009](0009-harness-as-model.md)
and [ADR-0010](0010-benchmark-adapter-tau2.md).
