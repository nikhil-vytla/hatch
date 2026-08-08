# ADR-0001 — Harness revisions and evolvable surfaces

Status: accepted — wire schemas revised in the 3A revision pass (2026-08-08), re-validated by spike round-trip tests, and frozen for Stage 3B. Implements charter D5.

## Context

The live system equates one generation with one strategy source file
(`generation@2`: a single `source_ref`). Stage 3 needs a candidate that
changes *several* surfaces at once — strategy code plus a prompt plus policy
parameters — with per-surface validation, risk, and rollback. The research
corpus shows both the need (Continual Harness evolves four surfaces per
refinement pass, note 03) and the failure mode of doing it untyped
(prime-agent's snapshots are the only recovery path because edits mutate
state in place, note 02).

## Decision

**`HarnessRevision` replaces "generation" as the unit of evolution.** A
revision is an immutable, journaled record:

- `ref: RevisionRef(scope, revision_id)` — identity is globally unambiguous:
  ids are sequential *per scope journal*, and the scope travels with every
  reference, so `rev-0001` at task scope can never collide with `rev-0001`
  at project scope (content addressing was rejected: identical deltas with
  different provenance must remain distinct identities).
- `base_parent: RevisionRef | None` — the revision the deltas apply to.
- `provenance_parents: tuple[RevisionRef, ...]` — additional lineage inputs
  (merge/crossover, the task-scoped origin of a cross-scope promotion);
  never repeats the base parent.
- `deltas: tuple[SurfaceDelta, ...]` — the complete change set.
- `state_manifest_ref` — content address of the revision's `HarnessManifest`:
  the complete resolved (kind, name, content_ref) state after the deltas
  apply. **Revisions own state, never evaluation conditions** — the
  `EvaluationManifest` was removed from revisions; a `ValidationBundle`
  (ADR-0004) pins the evaluation manifest it ran under, because one revision
  is routinely evaluated under many manifests (grown datasets, more seeds).
- provenance: `proposer` (name@version — always versioned, including the
  migration's own `ledger-migration@1`), `summary`; prompt/completion CAS
  refs travel via events as today.
- `created_at`.

**`SurfaceDelta` is typed CRUD plus mask** (per-edit schema after
prime-agent, note 02): `op ∈ {create, update, delete, mask}`, surface
`kind`, artifact `name`, and `before_ref`/`after_ref` content addresses.
Deltas carry **no risk field** — risk is computed, never trusted from a
proposal: `effective_risk(descriptor, scope, op)` derives it from the
descriptor's base risk, bumped one level at broad scopes (global/project)
and floored at medium for removals. Structural rules, kernel-enforced:
`create` has only `after_ref`, `delete` only `before_ref`, `update` both,
`mask` neither (it changes visibility, not content — see ADR-0002); no two
deltas may touch the same `(kind, name)`; every `kind` must be in the
trusted registry and allowed at the revision's scope level.

**`SurfaceDescriptor` is the versioned trusted allowlist entry** (kernel
data, never persisted as evolvable state): `kind`, `version`,
`artifact_schema`, `materializer` (id@version), `allowed_scopes` (scope
levels the kind may live at), `required_validators` (name@version),
`base_risk`, and `online_policy` (`never` today; a future descriptor version
may declare `provisional-only`). Planned kinds:

| kind | base risk | allowed scopes | online policy | materialization |
|---|---|---|---|---|
| `strategy-code` | high | task only | never | file in sandbox workspace, executed out-of-process |
| `prompt` | medium | all | never (stage 5 revisits) | text consumed by kernel-side model calls |
| `policy-params` | low | all | never (stage 5 revisits) | typed parameter bundle read by trusted components |

Adding a kind is a human code change to the registry — the loop cannot
extend its own allowlist.

**`SurfaceArtifact`** is the persisted unit an activation points at:
`(kind, name, scope, content_ref)`. Activation of a revision atomically
activates all artifacts its deltas produce (one journal line, same
atomic-by-construction property as today's activation).

**Rollback is a new revision, not a partial activation.** Whole-revision
rollback re-activates the parent (today's semantics). *Per-surface* rollback
is expressed as a new revision containing the inverse delta of the one
surface, validated and journaled like any candidate (fast-path policy
allowed for pure inversions). Rejected alternative: per-surface activation
pointers — they make "what is running right now" a join over N pointers and
destroy today's single-derivation invariant; a revision DAG keeps one active
node per scope.

**Compatibility.** Today's `generation@2` is exactly a one-delta revision:
`update strategy-code "solve"` with `before_ref` = the parent generation's
*content* ref (`parent.source_ref` — never a synthetic id string) and
`after_ref = source_ref`; the migration itself is a versioned proposer
(`ledger-migration@1`). The spike ships `revision_from_generation()`
(which refuses inconsistent parents) plus round-trip tests; Stage 3B's
migration (ADR-0006) rewrites task ledgers with that mapping. Until then the
live loop keeps writing `generation@2`.

## Consequences

- Usage attribution gains resolution: execution events will name
  `(revision_id, kind, name)` rather than a generation id (additive event
  payload change, Stage 3B).
- Decisions (ADR-0004) reference revisions, letting one decision cover a
  multi-surface candidate.
- The candidate workspace materializer becomes surface-driven: each delta's
  descriptor says how its artifact is rendered before sandboxed validation.

## Sources: borrowed / rejected / deferred

- **Borrowed** — prime-agent: typed CRUD + before/after snapshots (note 02).
  CH: the surface decomposition and per-surface repairability evidence
  (note 03). exo: artifacts as CAS refs, never inline (note 04).
- **Rejected** — CH's in-place mutation of live harness state (no retention
  of rejected candidates, no rollback); prime-agent's LLM-review promotion.
- **Deferred** — skills and subagent specs as kinds (stage 5, with memory);
  merge revisions with >1 parent (schema supports, no algorithm until
  population search); content-defined revision identity.
