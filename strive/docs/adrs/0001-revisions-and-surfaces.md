# ADR-0001 — Harness revisions and evolvable surfaces

Status: accepted (Stage 3A). Implements charter D5.

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

- `revision_id` — sequential per scope journal (content addressing was
  rejected: two revisions may carry identical deltas with different
  provenance, and identity must survive re-proposals).
- `parent_ids: tuple[str, ...]` — usually one; the tuple exists so future
  population search can record crossover/merge without a schema bump.
- `scope` — where the revision lives (ADR-0002).
- `deltas: tuple[SurfaceDelta, ...]` — the complete change set.
- `manifest_ref` — the `EvaluationManifest` (ADR-0003) it was validated
  under; null only for seeds.
- provenance: `proposer` (name@version), `summary`, and refs to the proposal
  artifact (prompt/completion CAS refs travel via events as today).
- `created_at`.

**`SurfaceDelta` is typed CRUD** (prime-agent's per-edit schema, note 02):
`op ∈ {create, update, delete}`, surface `kind`, artifact `name`,
`before_ref`/`after_ref` content addresses, and the surface's `risk_tier`
copied at proposal time (so history shows the risk as assessed then).
Structural rules, kernel-enforced: `create` has only `after_ref`, `delete`
only `before_ref`, `update` both; no two deltas may touch the same
`(kind, name)`; every `kind` must be in the trusted registry.

**`SurfaceDescriptor` is the trusted allowlist entry** (kernel data, never
persisted as evolvable state): `kind`, `risk_tier` (high/medium/low),
`online_adaptable` flag, required validators, and a materializer id (how the
artifact lands in a candidate workspace). Planned kinds and their tiers:

| kind | risk | online adaptable | materialization |
|---|---|---|---|
| `strategy-code` | high | never | file in sandbox workspace, executed out-of-process |
| `prompt` | medium | later (stage 5) | text consumed by kernel-side model calls |
| `policy-params` | low | later (stage 5) | typed parameter bundle read by trusted components |

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
`update strategy-code "solve"` with `before_ref = parent.source_ref`,
`after_ref = source_ref`. The spike ships `revision_from_generation()` plus a
round-trip test; Stage 3B's migration (ADR-0006) rewrites task ledgers with
that mapping. Until then the live loop keeps writing `generation@2`.

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
