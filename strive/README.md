# strive

**Durable mechanisms for model-led adaptation.** Strive is a policy-neutral,
revision-native substrate: one run-scoped, semantically-verified event/CAS
store and a result-driven, resumable policy kernel that let a policy
**apply, observe, checkpoint, and revert EXACT composite changes** to
allowlisted surfaces. Comparative evaluation is an OPTIONAL mechanism a
policy requests — not a universal activation gate. (This is the vNext reset;
the promotion-era design, Stages 1–3C, is archived under `docs/archive/`.)

## Quickstart

```bash
uv sync
uv run strive run                 # bind + drive a manual-change@1 run
uv run strive runs                # list runs under ./artifacts
uv run strive status              # the verified view of the latest run
uv run strive view                # the current composite HarnessState
uv run strive history             # the ordered event stream (id, kind, cause)
uv run strive inspect --event 8   # decode one event body as JSON
uv run strive revert manual-change-1   # revert an applied change, exactly
uv run strive repair              # quarantine + truncate an unverified tail
uv run strive sandbox             # sandbox backends + enforced capabilities
```

`uv run pytest` and `uv run mypy` are green (`--strict`).

## The idea

The harness does not decide *whether a change is good* — a policy does. What
the harness guarantees is that model-led change is **durable, verifiable, and
exactly resumable**:

- **Revision-native state.** Harness state is a composite of allowlisted
  surface bindings (`strategy-code/solve`, `prompt/proposal-template`), each
  pinned to exact content in a content-addressed store. A change is coupled,
  exact before→after per surface, and invertible.
- **A verified event log.** One artifact root holds many runs; each run is an
  append-only, crash-framed, hash-chained stream of `EventEnvelope`s (stable
  id, run/task scope, command causation, timestamp). Nothing mutates over an
  unverified log: `verify()` replays every apply/revert exactly, checks CAS
  closure and the command lifecycle, and refuses on any structural or
  semantic error.
- **A resumable kernel.** One command at a time — one intent, one effect
  (performed or reconciled), one terminal result — then `reduce` and
  checkpoint. State never advances before the outcome; a crash at any
  boundary resumes exactly, with no duplicated effect, model call,
  observation, or spend.
- **A policy boundary.** `AdaptationPolicy` emits a small closed command
  vocabulary (`ApplyChange`, `EvaluateFork`, `RevertChange`, …); `EvaluateFork`
  is how a policy *requests* comparative evaluation. Policies are packages:
  typed code + frozen TOML config + versioned Markdown instructions, pinned
  per run by implementation, config, prompts, and seed.
- **A floor that is not configurable.** Allowlisted surfaces, exact
  before/after, expected-head conflict checks, CAS integrity, append-only
  tamper-evident events, budgets, the secure `CandidateExecutor` sandbox
  boundary with declared capabilities, checkpoints/rollback, crash recovery,
  and explicit (never silent) repair.

## Layout

See `docs/ARCHITECTURE.md` for the module map, `docs/PROJECT_CHARTER.md` for
the thesis and floor, `docs/ROADMAP.md` for what's next
(`continual-refine@1`), and `docs/adrs/0008-vnext-substrate.md` for the
design decision.

## The proof policy

`manual-change@1` (deterministic) builds one coupled prompt+code change,
`EvaluateFork`s it (the optional comparative mechanism), and — reacting to
the fork through its reducer — applies then reverts it exactly. Honest
scope: the fork scores the code surface; the prompt surface is round-trip
only until `continual-refine@1` adds a real prompt consumer.
