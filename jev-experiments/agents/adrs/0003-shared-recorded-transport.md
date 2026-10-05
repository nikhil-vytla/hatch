# One recorded transport for cloud calls

Status: accepted, 2026-09-19. Amended 2026-10-04 (below).

All cloud experiments use the same Python transport and persistent budget ledger. This avoids independent experiments accidentally overspending, keeps credentials out of the browser, and makes replays possible. The browser runs local inference and rendering; the loopback service owns cloud requests. Exact monetary reservations are conservative estimates, reconciled against returned gateway charges, with the account's existing limit as a second bound.

## Amended 2026-10-04

The decision above held for the Python runs, but the TypeScript recorders never used it. By October about twenty TypeScript scripts recorded Jev for the site's scenes. Each one called the site's gateway client directly and carried its own copy of the key check, resume, spend cap and failure streak. None was tested. The site's own live calls go through its API functions, not the loopback service.

TypeScript recording now goes through one shared recorder module, `packages/jev-client/src/recorder.ts`, beside the Jev client it calls (`packages/jev-client/src/gateway.ts`). A recorder script gives it a list of jobs (id → request) and its caps. The module owns:

- the key check;
- resuming from answered rows;
- the spend cap, the failure streak and retry of busy replies;
- dry runs and the receipt.

Reading recordings back has one owner too: `packages/jev-client/src/recordings.ts` handles rows, the latest answer per id, failures left out, receipt totals, and the rule that an uncompressed working copy wins over the committed `.gz`. The module is tested once against the local mock endpoint. Each recorder is tested to send the same job ids and requests as before, and to write rows of the same shape.

Python runs keep the Python transport and the SQLite budget ledger (`src/jev_lab/core.py`). Neither side imports the other's code. What they share is the record format and the price:

- Python's `jev-records-v1` documents are read and written byte for byte by `experience-prototypes/scripts/records.ts`; `server/records.test.ts` checks this.
- Both sides' JSONL recordings follow the same working-copy-over-`.gz` rule.
- Jev's list price lives in `packages/jev-client/src/price.ts`. `core.py` keeps a copy and names that file.

Why not route TypeScript through the Python ledger: the TypeScript recorders run under Bun beside the scene code that builds their requests. Sending every request through a Python process would put a second runtime and a second request shape between a scene and its recording. It would not remove a single cap or retry rule. What ADR-0003 wanted was one place that guards spend, and one tested module per language achieves that. Two transports remain, so a cap set in one is not seen by the other. The account's limit is still the bound across both.
