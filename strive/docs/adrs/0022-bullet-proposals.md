# ADR-0022: Memory proposals change one bullet

Status: accepted, not built. Replaces the plan to keep proposals in the
shadow repository (the simplification plan's item 5).

## Context

A memory proposal carries the file's whole new text, and accepting it
replaces the file. A hands-on review (NOTES, 2026-09-29) found what that
costs:
- **Hidden edits.** A proposal titled "Say where the unit tests live" also
  rewrote another bullet and dropped a fact. A reviewer reading the summary
  can't see that, and the static check can't either.
- **Undo is newest-first and fragile.** Rolling back an older proposal is
  refused once a newer one is accepted, and one hand edit to the file
  blocks every rollback.
- **Nothing says where a line came from** once it's in the file.
- **Whole rewrites collapse context:** ACE (2510.04618) saw one rewrite
  shrink an 18,000-token context to 122 tokens, below the no-memory
  baseline; its fix is itemized delta updates.

Tools with per-item memory (Hermes, ChatGPT, Prime Agent) undo per item, and
Codex and exo keep a source for each entry.

## Decision

### Memory is a list of bullets, each with an ID

`.strive/memory.md` stays plain markdown that people and other tools can
read. Each bullet the learner wrote ends with an HTML comment naming its
source, invisible when rendered:

```markdown
- Run the tests with `bun test src`; the root run also needs a display. <!-- strive:#42 -->
```

`#42` is the proposal (its seq in the learning journal) that last wrote the
bullet. Bullets a person wrote by hand have no comment and no source.

### One proposal changes one bullet

A memory proposal is one operation:
- **add** `{text, after?}`: a new bullet, after a given bullet or at the end;
- **change** `{bullet, text}`: new text for an existing bullet;
- **remove** `{bullet}`: deletes one.

`bullet` names a bullet by its source ID, or, for a hand-written bullet, by
its exact current text. A run still proposes at most three.

Skills stay whole-file for now: a skill is one document with its own
structure, and new skills are the common case.

### Accept and rollback act on the bullet, not the file

- **Accept** applies the operation to the file as it is now. For change and
  remove, the bullet must still read as it did when the learner saw it,
  otherwise the proposal is stale. Edits elsewhere in the file don't matter.
- **Rollback** undoes just that operation: remove the added bullet, put back
  the old text of a changed one, reinsert a removed one where it was. It's
  refused only if that bullet has changed since, and the refusal says so.
- Order no longer matters: #16 can be rolled back after #46.

### What the checks and the reviewer see

- The diff is one bullet: one line removed, one added, or both.
- The static check caps a bullet's length (500 characters) and still caps
  the file at 16 KiB, and refuses an add that duplicates an existing bullet.
- `strive review --memory` and the desktop show the memory as every session
  reads it now, each bullet with its source and a link to that proposal.
- The learner sees each bullet's source, so it can tell learned lines from
  a person's, and cite or change the right one.

## Consequences

- Hidden edits become impossible: a proposal can only touch the one bullet
  it names.
- Undo is per bullet and survives hand edits elsewhere.
- Stale detection, apply and rollback get simpler; moving proposals into the
  shadow repository is no longer needed.
- The protocol changes (version 3): `ProposalMade` carries an operation for
  memory. A memory file without source comments still works; its bullets
  count as hand-written.
- A consolidation pass (merge and prune) can come later as ordinary remove
  and change proposals.
