# Parallax decision records

These are the direct ancestors of [`../MODEL.md`](../MODEL.md) and
[`../methods/evolving-intent.md`](../methods/evolving-intent.md). They record
decisions already made and keep the original substance. They do not define
implemented behavior, so if one of them disagrees with the code, the code wins.

- [`ADR-001.md`](ADR-001.md) decides to place one immutable research protocol
  above strategy-specific state machines, rather than build a universal
  transformation algebra.
- [`DESIGN-SELECTION.md`](DESIGN-SELECTION.md) holds the four-candidate
  architecture arena, the cross-judge scorecard, the winning design, and which
  grafts were accepted or rejected.
- [`LITERATURE-PINS.md`](LITERATURE-PINS.md) is the primary-source pin table:
  the exact papers, repository revisions, and release records the decisions were
  checked against, with what each source does and does not fix.

The full experimental archive lives on the archive branch
[`cursor/hard-repo-tasks-5fc8`](https://github.com/nikhil-vytla/hatch/tree/cursor/hard-repo-tasks-5fc8/hard-repo-tasks),
under `hard-repo-tasks/architecture/`: the formal model, the complete literature
review, the arena candidate files and judge record, the episode-spine and
synthesis-kernel investigations, and the working notes. That branch archives a
superseded experiment. It is not a merge candidate.
