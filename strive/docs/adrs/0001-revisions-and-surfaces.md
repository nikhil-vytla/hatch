# ADR-0001 — Harness revisions and evolvable surfaces

Status: core wire schemas FROZEN for Stage 3B (final pre-merge pass, 2026-08-08). Implements charter D5.

## Context

The live system equates one generation with one strategy source file
(`generation@2`: a single `source_ref`). Stage 3 needs a candidate that
changes *several* surfaces at once — strategy code plus a prompt plus policy
parameters — with per-surface validation, risk, and rollback. The research
corpus shows both the need (Continual Harness evolves four surfaces per
refinement pass, note 03). prime-agent is the closest prior art and is
*typed* — validated CRUD edits, version counters, invertible journaled
rollback (note 02); the cautionary lesson it carries is different: its
primary state is mutated in place, so historical reconstruction rests on
snapshot discipline rather than immutable records.

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
- `deltas: tuple[SurfaceDelta, ...]` — the complete change set, in
  canonical (kind, name) order; duplicates, self-referencing parents, and
  duplicate parents are rejected.
- `scope_manifest_ref` — content address of the revision's `ScopeManifest`:
  the bindings (artifacts *and masks*) this revision owns **at its own
  scope** after the deltas apply. Cross-scope resolution is deliberately not
  a revision's business: runs and evaluations reference a
  `ResolvedHarnessManifest` — the effective bindings after
  run→task→project→global resolution plus, per contributing scope, the
  active revision ref and journal head that contributed (ADR-0002).
  **Revisions own their scope's state, never evaluation conditions** — a
  `ValidationBundle` (ADR-0004) pins the evaluation manifest it ran under,
  because one revision is routinely evaluated under many manifests.
- provenance: `proposer` (name@version — always versioned, including the
  migration's own `ledger-migration@1`), `summary`, and optional
  `proposal_ref`/`provenance_ref` CAS pointers to the structured proposal
  and provenance records.
- `created_at`.

**`SurfaceDelta` is a complete binding transition**, not an op with
nullable refs. Artifact state at a scope is an `ArtifactBindingState`:
`absent | masked | content(content_ref, descriptor_ref)`; a delta stores the
full `before` and `after` states. `create/update/delete/mask/unmask` are
*derived labels* (`delta_label`), which makes three things representable by
construction: **exact inversion** (swap the states — per-surface rollback is
`invert_delta`), **unmasking** (masked→absent resumes inheritance,
masked→content replaces the tombstone), and **conflict checks** (a delta
applies only where the current binding equals its recorded `before`).
Deltas carry **no risk field** — risk is computed, never trusted from a
proposal: the descriptor's risk policy derives it from (artifact name,
scope, transition label), bumped at broad scopes and floored at medium for
removals. Every `kind` must be in the trusted registry and allowed at the
revision's scope level; no-op transitions are rejected.

**`SurfaceDescriptor` is the versioned trusted allowlist entry** (kernel
data, never persisted as evolvable state): `kind`, `version`,
`artifact_schema`, `materializer` (id@version), `allowed_scopes`,
`validation_policy` (name@version), `risk_policy_ref` (name@version into the
trusted risk-policy registry), and `online_policy`. Persisted content
bindings **pin `descriptor_ref = kind@version`**, so history records which
descriptor governed each binding. Risk policies see the artifact *name*, so
one kind need not be one risk bucket — **policy parameters are explicitly
not universally low-risk**: parameters steering budgets or the sandbox rank
high, search/retry knobs medium, cosmetic families low. Planned kinds:

| kind | risk policy | allowed scopes | online policy | materialization |
|---|---|---|---|---|
| `strategy-code` | code-risk@1 (high) | task only | never | file in sandbox workspace, executed out-of-process |
| `prompt` | prompt-risk@1 (medium) | all | never (stage 5 revisits) | text consumed by kernel-side model calls |
| `policy-params` | params-risk@1 (tiered by family) | all | never (stage 5 revisits) | typed parameter bundle read by trusted components |

Adding a kind is a human code change to the registry — the loop cannot
extend its own allowlist.

**Activation is `RevisionActivation@1`** (frozen): the revision's
`RevisionRef`, durable/provisional mode, reason, timestamp, a versioned
`policy_ref` (legacy unversioned markers map to the reserved `name@0` era),
an optional `decision_ref` into CAS, and the provisional monitoring data
(`expires_after_cycles`, `baseline_score`) — preserving every `activation@2`
field. Active-state derivation is unchanged: the last activation line in a
scope's append-only journal names the active revision, so activating a
revision atomically activates all bindings in its scope manifest (one
journal line, the same atomic-by-construction property as today).

**Rollback is a new revision, not a partial activation.** Whole-revision
rollback re-activates the parent (today's semantics). *Per-surface* rollback
is expressed as a new revision containing the inverse delta of the one
surface, validated and journaled like any candidate (fast-path policy
allowed for pure inversions). Rejected alternative: per-surface activation
pointers — they make "what is running right now" a join over N pointers and
destroy today's single-derivation invariant; a revision DAG keeps one active
node per scope.

**Compatibility.** Today's `generation@2` is exactly a one-delta revision:
an `update`-labeled transition on strategy-code "solve" whose `before` is
the parent generation's *content binding* (`parent.source_ref` with the
pinned descriptor ref) and whose `after` binds `source_ref`; the migration
itself is a versioned proposer (`ledger-migration@1`). The spike ships `revision_from_generation()`
(which refuses inconsistent parents) plus round-trip tests. Fields with no
direct revision slot — task fingerprint, origin, weakness id, and the
embedded `decision@1` acceptance/rejection evidence — are preserved
losslessly in a CAS `MigrationProvenance` record referenced from
`provenance_ref`, with the decision itself codec-encoded into CAS
(`decision_ref`). **Stage 3B is dual-write, not a rewrite**: the loop keeps
writing generation-native records (so `cycle@1` records and
execution-and-decision replay are untouched) while revisions and revision
activations are written alongside and backfilled by migration entry 0002;
the loop/activation/replay become revision-native only in a later slice
after dual-write parity is proven.

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
