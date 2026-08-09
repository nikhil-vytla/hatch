# ADR-0002 — Artifact scopes: inheritance, shadowing, promotion

Status: core wire schemas FROZEN for Stage 3B (final pre-merge pass, 2026-08-08).

## Context

Phase 4.5 made ledgers task-scoped, which fixed cross-task contamination but
created a new trap: if per-task ledgers are the *only* ownership model, a
reusable prompt or policy improved for one task cannot benefit another
without copy-paste forks, and "the same prompt, evolved twice" becomes two
unrelated lineages. prime-agent's local/global tiers (note 02) are the
closest prior art; CH's bootstrap-transfer results (note 03) are the evidence
that cross-run/cross-task reuse is where compounding improvement comes from.

## Decision

**Four scope levels, ordered from broadest to narrowest — plus one
activation mode:**

1. `ScopeRef(global)` — org-wide defaults (e.g., the proposal prompt template).
2. `ScopeRef(project, family)` — a task family sharing conventions and assets.
3. `ScopeRef(task, task_id)` — exactly today's granularity; strategy code lives here.
4. `ScopeRef(run, run_id)` — session-local overlays; never durable by themselves.
5. provisional-online — **not a fifth place in the hierarchy but an
   activation mode** (`provisional`) that can attach to an activation at any
   scope; it marks "active but expiring unless confirmed" exactly as today.
   Rejected alternative: modeling provisional as a scope — it conflates
   *where* an artifact applies with *how much evidence* backs it, and we
   already have working provisional mechanics keyed on activation mode.

**Scopes are typed, never parsed.** `ScopeRef(level, name)` with a closed
level vocabulary replaces colon-encoded strings; `global` requires an empty
name and everything else a non-empty one. Resolution runs over an explicit
`ResolutionContext` built by trusted code from what is actually known —
**there is no implicit default project**: a projectless task resolves
`task → global`, full stop.

**Resolution = nearest-scope shadowing.** Walk the context's chain
(`run → task → project → global`) and take the first hit. Shadowing is total
(no partial merging of artifact contents — an artifact is one CAS blob).

**Remove-override vs mask-inherited.** Two distinct operations with distinct
semantics: `delete` removes *this scope's own override*, so resolution falls
through and the inherited artifact becomes visible again; `mask` writes a
tombstone at this scope that *stops* the fall-through, making the artifact
deliberately absent here while siblings and broader scopes are unaffected.
Both are journaled deltas; both floor at medium risk (ADR-0001).

**Two manifests, two owners.** A revision owns a `ScopeManifest`: the
bindings (content and masks) at *its* scope. What a run actually executes
under is a `ResolvedHarnessManifest`: the effective content bindings after
walking the resolution chain, together with each contributing scope's active
revision ref and journal head — so "what configuration produced this run" is
one journaled, replayable record rather than a join reconstructed after the
fact. Runs and evaluations reference resolved manifests; revisions never do.

**Ownership.** Artifacts live in the shared CAS (content-addressed, already
scope-free). *Membership and activation* live in per-scope journals:
task journals stay as-is; project and global scopes get their own
journal files with the same append-only + head-check semantics. A revision
belongs to exactly one scope (its deltas activate there); a task-scoped run
*reads through* to broader scopes but never writes them.

**Promotion across scopes is a gated selection, not a copy.** Moving a prompt
from `task:X` to `project:P` requires evidence that it does not regress the
*other* tasks in P — i.e., a `SelectionDecision` (ADR-0004) whose manifest
covers a sample of P's tasks, journaled in P's journal with the originating
revision as parent. Rollback at a scope re-activates that scope's parent
revision and never touches narrower scopes (a task that shadowed the promoted
artifact keeps its shadow).

**Drift interaction.** The task-fingerprint drift guard stays task-scoped.
Broader scopes have no task fingerprint; their manifests (ADR-0003) pin which
task versions the evidence covered, so stale evidence is detectable at
promotion time instead.

## Consequences

- `Store` grows from "task journal" to "scope journal" with the same
  mechanics (constructor takes a scope, not just a task id) — Stage 3B work.
- The CLI needs a `--scope` notion only when non-task scopes gain their first
  real artifact kind (prompts), not before.
- Every run journals its `ResolvedHarnessManifest` ref, so replay
  re-materializes the exact effective configuration including inherited
  bindings and masks.

## Sources: borrowed / rejected / deferred

- **Borrowed** — prime-agent: local/global tiers as blast-radius control
  (note 02); CH: harness state as the transferable unit across runs
  (note 03).
- **Rejected** — exo's treatment of *evolvable state* as one global mutable
  tree (its repo workspace). To be precise about exo: it does scope secrets
  (root/agent/conversation) and supports conversation forking (note 04) —
  what strive rejects is specifically the unscoped mutable workspace for the
  state the loop evolves. Also rejected: copying artifacts between scopes
  without evidence.
- **Deferred** — user/tenant scopes; scope-level ACLs; automatic promotion
  suggestions ("this task-local prompt wins on 3 sibling tasks") until
  usage-attribution statistics exist.
