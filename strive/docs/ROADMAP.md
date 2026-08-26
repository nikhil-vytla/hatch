# strive — Roadmap (vNext)

The promotion-era roadmap (Stages 1–3C) is archived under
`docs/archive/ROADMAP-stage1-3c.md`. vNext is organized around policies over
one durable substrate.

## Phase A — the substrate and the resumable kernel (done)

- Run-scoped, semantically-verified event/CAS substrate
  (`strive.substrate`): composite `HarnessState`, coupled `CompositeChange`
  with exact before/after, `EventEnvelope` with stable ids + causation,
  `VerifiedSubstrateView` (framing + CAS closure + exact apply/revert replay
  + command lifecycle + digest/change-id uniqueness), explicit `repair`.
- Result-driven, resumable kernel (`strive.kernel`): `next_command` +
  `reduce`; one intent / one effect / one terminal per command; exact resume
  and reconciliation for Apply, Revert, EvaluateFork, Confirm, Schedule,
  Stop (RequestRefinement reserved); the floor (bound identity, budgets,
  sandbox capabilities + provenance, CAS closure, fork base/candidate refs).
- The `strive` CLI: run / status / view / history / inspect / revert /
  repair / sandbox, over one artifact root with many runs.
- `manual-change@1`: a deterministic proof policy — propose → OPTIONAL fork
  → (react through the reducer) apply → revert, exactly and resumably.

## Phase B — `continual-refine@1` (IMPLEMENTED; under review in PR #51)

A Prime-Agent / Continual-Harness-style **end-to-end refinement policy** over
this substrate, UNCHANGED — NOT Pareto search:

- iterative diagnose → refine → (optionally) fork-evaluate → apply/keep or
  revert, driven entirely by the policy's `next_command`/`reduce`;
- a real model refiner behind `RequestRefinement` (typed proposal decoding,
  journaled once, resumed without repeating the model call);
- a real prompt CONSUMER so the prompt surface is not merely round-trip;
- honest, optional comparative evaluation the policy composes — never a
  universal gate.

## Later

- Additional strategies and coupled multi-surface refinement.
- A budget-matched policy comparison (e.g. hill-climb vs population search)
  expressed as ordinary policies over the substrate, journaled as
  command/reducer state machines — never baked into the kernel.
- Broadening the surface allowlist as new evolvable surfaces earn a
  descriptor + validator.
