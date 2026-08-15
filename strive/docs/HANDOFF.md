# HANDOFF — strive (vNext)

## Current: vNext Phase A (hardened), on branch `strive-vnext-phaseA`

Strive is a policy-neutral, revision-native mechanism substrate plus a
result-driven, resumable policy kernel. Comparative evaluation is an optional
mechanism a policy requests, never a universal activation gate. This is the
third correction pass on the Phase-A PR: it makes run identity exact,
verification pure/closed/complete, command and policy identity strict,
effect/budget semantics honest and restart-safe, the CAS + surface catalog
hardened, and keeps every mutation (including operator reverts) on the
command path.

### Correction pass (what changed since the last review)

- **Exact run identity.** Run ids are opaque validated tokens (no separators,
  no `..`); the task is discovered from a persisted `RunBinding` index, never
  parsed from the id. `PolicyBound` now pins the task fingerprint, policy
  implementation digest, config, prompts, seed + seed state, budget spec,
  required capability profile, and surface-catalog digest; resume rejects any
  caller that disagrees.
- **Pure, closed, complete `verify()`.** Verification never writes CAS (the
  replay recomputes expected refs with `hash_text`), accepts only the closed
  substrate body union, checks command causation/one-terminal/one-digest,
  observation + proposal refs, revert-after-unreverted-apply, binding-index
  agreement, and the surface-catalog digest — and on any error exposes NO
  active state.
- **Strict identity + codecs.** The kernel re-derives a command's payload
  digest and compares it before both the already-issued and already-completed
  paths; canonical encoding is strict typed JSON (no `default=str`); config /
  policy-state blobs pin an encoder version; TOML config loading rejects
  non-string values; the public `VerifiedSubstrateView` mappings are
  read-only proxies.
- **Honest effects + budgets.** Durable state effects reconcile exactly; a
  completed fork's base/candidate refs and metered usage are recorded durably
  and REUSED on resume (never re-executed or re-charged); the budget spec is
  pinned in CAS and cumulative spend is re-seeded from durable usage, so a
  restart cannot reset or expand the budget; wall + cumulative output are
  enforced alongside execution count.
- **Hardened CAS + injected surface catalog.** CAS refs are validated as
  canonical sha256 (traversal-safe), reads are hash-verified, publication is
  concurrent-writer safe (unique temp + fsync + atomic replace). Surfaces come
  from an injected immutable `SurfaceCatalog` with trusted structural
  validators (code parses to exactly one `solve(input_text)`; prompt is
  non-empty) run before seed/apply.
- **Mutation stays on the command path.** `strive revert` issues a durable
  operator `RevertChange` command through the kernel (`operator_revert`),
  never a direct `Substrate.revert`.

### Modules

- **`strive.substrate`** — one artifact root, many runs
  (`<root>/runs/<run_id>.events`), CAS shared at `<root>/objects`. Composite
  `HarnessState`; coupled `CompositeChange` (exact before/after, invertible);
  `EventEnvelope` (stable `<run_id>#<seq>` id, run/task scope, `caused_by`,
  timestamp, CAS body ref). `verify()` → `VerifiedSubstrateView` checks
  framing, one leading `PolicyBound`, CAS closure, canonical/allowlisted
  bindings, an EXACT apply/revert replay, command lifecycle + one terminal +
  one payload digest per command id, checkpoint agreement, observation
  subjects, and change-id uniqueness. Authority appends verify first and are
  head-checked; a structural/semantic error refuses mutation. `repair`
  quarantines only a torn/forged tail (semantic corruption is refused, not
  auto-quarantined).
- **`strive.surfaces`** — the injected immutable `SurfaceCatalog`
  (`SurfaceDescriptor` per legal surface) and trusted structural validators
  (`validate_solve_code`, `validate_prompt`); its `descriptor_digest()` is
  pinned per run.
- **`strive.policy`** — `AdaptationPolicy[Config, State]` (`next_command` +
  `reduce`, `decode_state`) and `SurfaceStrategy`; the closed command
  vocabulary; immutable `RunView`; injected immutable `PolicyCatalog` with a
  `conformance_violations` suite.
- **`strive.kernel`** — the result-driven loop: one intent / one effect
  (perform or reconcile) / one terminal result per command, then reduce and
  checkpoint (state + consumed-result cursor). Never advances before the
  outcome; restart reconstructs the exact result. Enforces the floor —
  authoritative bound identity, trusted budgets, sandbox capabilities +
  exact `SandboxProvenance`, CAS closure before apply, and fork base/candidate
  refs captured before execution.
- **`strive.policies.manual_change`** — `manual-change@1`: `policy.py` +
  `manual_change.toml` + `prompts/manual_change_refine@1.md`. Emits
  `ChangeProposed`, uses run-scoped ids, and reacts to fork success/failure
  through the reducer (applies+reverts on improvement; stops otherwise).
- **`strive.cli`** — `strive run/runs/status/view/history/inspect/revert/
  repair/sandbox`.

### Honest scope

`manual-change@1`'s fork scores the **code** surface over the task's cases;
the **prompt** surface is coupled into the same change and applied+reverted
round-trip, but no scorer consumes it yet. A real prompt consumer and a real
model refiner arrive with `continual-refine@1`.

### Verification

- `uv run pytest` — 159 tests. The Phase-A floor (substrate verified view,
  missing-CAS + semantic-corruption refusal, concurrent heads, multiple runs,
  exact revert; kernel happy path + identity/seed mismatch + budget + fork
  reaction + idempotent re-run + crash after every command effect +
  fork-crash-without-duplicate-execution + crash-before-apply; CLI flow +
  installed entry point; codec; sandbox) PLUS the correction-pass adversarial
  matrix: CAS traversal/corruption/concurrent-writers (`test_cas`), surface
  validators + catalog digest (`test_surfaces`), and `test_adversarial`
  (run/task spoofing, traversal run ids, hyphenated-task discovery, binding
  tamper, unknown body kinds, corrupt-but-present CAS hiding state, verify
  purity, arbitrary/duplicate revert, changed re-derived commands, budget
  reset/expansion refusal, structurally-invalid seed + staged content), plus
  a built-wheel package-data + console-script check (`test_packaging`).
- `uv run mypy` — clean, `--strict`, over 35 files (src + tests).
- `uv run strive` — installed console script; verified in tests and smoke.

### The Phase-A claim

Strive has a path-safe, task-bound, semantically closed event/CAS substrate
and a strictly typed, result-driven kernel: durable state effects reconcile
exactly, external effects have honest idempotency semantics, budgets survive
restart, and every policy or operator change passes validated surface and
command boundaries — exact across concurrency and crashes.

### Next

After review + merge: begin the Prime-Agent / Continual-Harness-style
`continual-refine@1` end-to-end policy (a real model refiner behind
`RequestRefinement`, a real prompt consumer, optional composed fork
evaluation). See `docs/ROADMAP.md`.

The promotion-era handoff is archived at
`docs/archive/HANDOFF-stage1-3c.md`.
