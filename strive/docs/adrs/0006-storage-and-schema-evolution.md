# ADR-0006 — Storage backends and the migration registry

Status: accepted — wire schemas revised in the 3A revision pass (2026-08-08), re-validated by spike round-trip tests, and frozen for Stage 3B.

## Context

Storage today is concrete: JSONL journals re-parsed in full on every query,
a sha256 CAS, JSONL event files, and no indexes. That is the right
transparency for the current scale and exactly wrong for population search
(a frontier query over thousands of revisions must not re-read every journal
line). Schema evolution today is ad hoc: the generation@1→@2 bump shipped
with one bespoke `migrate.py`; a third one-off would start a pile.

## Decision

**Four backend protocols, JSONL as the reference implementation.**

- `LedgerBackend` — `append(entry, expected_head) -> head`,
  `append_batch(entries, expected_head) -> head` (all-or-nothing under one
  head check: a revision + its activation land atomically or not at all),
  `entries()`, `entries_since(cursor) -> (entries, cursor)` (cursor reads, so
  indexes and long-running consumers never re-parse whole journals), and
  `head()`. Append-only and expected-head conflict semantics are part of the
  *protocol contract*, not the file format: any backend must refuse an append
  whose expected head is stale and must never mutate or delete. The JSONL
  implementation keeps its torn-tail tolerance and advisory flock.
- `ArtifactBackend` — today's CAS interface (`put_text/get_text/has`),
  plus planned fsync-on-publish (closing the CAS power-loss durability gap
  noted since phase 3).
- `EventBackend` — per-run append streams; unchanged semantics.
- `IndexBackend` — **derived, rebuildable, never authoritative**, with
  **index-through-head semantics**: every index records the journal head
  (per scope journal) through which it is current; a query first compares
  the recorded head with the journal head and either serves (equal), catches
  up incrementally via cursor reads (behind), or discards and rebuilds
  (ahead/unknown — a corrupt or foreign index is detected, not trusted).
  Deleting an index is always safe. Planned first implementation: a local
  SQLite file per artifact root, built lazily, landing *before*
  `pareto-population@1` (its frontier queries are the first workload that
  hurts on JSONL).

Rejected alternative: making SQLite the journal itself. The JSONL journal's
greppable transparency has caught real bugs in every phase so far and is the
audit story; the split "transparent journal + disposable index" keeps both
properties.

**Migration registry, not one-off scripts.** A single ordered registry:

```python
@dataclass(frozen=True)
class Migration:
    migration_id: str      # e.g. "0002-task-scoped-ledgers"
    applies_to: str        # ledger layout or record kind@version range
    def check(store) -> bool          # is it needed?
    def apply(store) -> MigrationReport
```

Rules, all inherited from the phase-4.6 legacy migration and now made
uniform: migrations run sequentially in registry order; each is
detect-loudly-first (an unmigrated layout refuses normal operation with the
exact command, as `LegacyLedgerError` does today); each preserves the
original files byte-for-byte and journals a migration marker with the
source's content hash; each validates its output end-to-end before declaring
success; `strive migrate` (generalizing `migrate-legacy`) applies pending
migrations one at a time. The existing legacy migration becomes registry
entry `0001`. Superseded record versions keep failing loudly when read
without migration — no silent reinterpretation, ever.

**Planned Stage 3B migration `0002`:** task ledgers gain revision records
(`generation@2 → revision@1 + surface artifacts`) using ADR-0001's
one-delta mapping; scope journals for `project`/`global` are created empty.

## Consequences

- `Store` refactors to compose backends instead of owning file I/O; its
  public API (entries, activation, head checks) is unchanged for callers.
- Population search gets O(1)-ish frontier reads from the index; correctness
  never depends on the index existing.
- Every future schema bump costs: a version bump + a registry entry + a
  round-trip test + a golden update. That price is deliberate — it is what
  keeps "unsupported version" errors honest.

## Sources: borrowed / rejected / deferred

- **Borrowed** — exo: append-only event files with optimistic head checks and
  durable operation intents (note 04); NOOA: versioned schemas with
  normative tests and explicit migration discipline (note 06).
- **Rejected** — mutable databases as source of truth; background/implicit
  migration on read (silent reinterpretation is the CH stall lesson applied
  to storage).
- **Deferred** — multi-host/concurrent-writer backends (single writer per
  scope journal stands); remote artifact backends; event-stream compaction;
  CAS garbage collection (nothing is deleted until an explicit retention
  policy ADR exists).
