# ADR-0002 — Artifact scopes: inheritance, shadowing, promotion

Status: accepted (Stage 3A).

## Context

Phase 4.5 made ledgers task-scoped, which fixed cross-task contamination but
created a new trap: if per-task ledgers are the *only* ownership model, a
reusable prompt or policy improved for one task cannot benefit another
without copy-paste forks, and "the same prompt, evolved twice" becomes two
unrelated lineages. prime-agent's local/global tiers (note 02) are the
closest prior art; CH's bootstrap-transfer results (note 03) are the evidence
that cross-run/cross-task reuse is where compounding improvement comes from.

## Decision

**Five scopes, ordered from broadest to narrowest:**

1. `global` — org-wide defaults (e.g., the proposal prompt template).
2. `project:<family>` — a task family sharing conventions and assets.
3. `task:<task_id>` — exactly today's granularity; strategy code lives here.
4. `run:<run_id>` — session-local overlays; never durable by themselves.
5. provisional-online — **not a fifth place in the hierarchy but an
   activation mode** (`provisional`) that can attach to an activation at any
   scope; it marks "active but expiring unless confirmed" exactly as today.
   Rejected alternative: modeling provisional as a scope — it conflates
   *where* an artifact applies with *how much evidence* backs it, and we
   already have working provisional mechanics keyed on activation mode.

**Resolution = nearest-scope shadowing.** To resolve artifact `(kind, name)`
for a task run, walk `run → task → project → global` and take the first hit.
Shadowing is total (no partial merging of artifact contents — an artifact is
one CAS blob).

**Ownership.** Artifacts live in the shared CAS (content-addressed, already
scope-free). *Membership and activation* live in per-scope journals:
task journals stay as-is; `project:<family>` and `global` get their own
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
- Cross-scope reads make "what configuration produced this run" a resolved
  set; the run's events must journal the resolution (which artifact version
  won at each scope) for replayability.

## Sources: borrowed / rejected / deferred

- **Borrowed** — prime-agent: local/global tiers as blast-radius control
  (note 02); CH: harness state as the transferable unit across runs
  (note 03).
- **Rejected** — exo's single global mutable workspace (no scoping at all,
  note 04); copying artifacts between scopes without evidence.
- **Deferred** — user/tenant scopes; scope-level ACLs; automatic promotion
  suggestions ("this task-local prompt wins on 3 sibling tasks") until
  usage-attribution statistics exist.
