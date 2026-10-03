# Changes audit probe

The dedicated report is [experiments/changes.md](../../experiments/changes.md), with structured findings in [changes.json](../../experiments/changes.json). Run `bun jev-experiments/quality-and-simulation-review/probes/changes.ts` from the repository root; it writes [probe evidence](../changes.json) after executing the real component callbacks with controlled hooks and deferred responses.

The published four judgments match a code lookup using dependency annotations already supplied to Jev. The probe reproduces a stale venue response attached to an edited date, plus missing-record values displayed as support. All checks are offline; no browser, model calls or application changes were involved.
