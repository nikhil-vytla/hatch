# One recorded transport for cloud calls

Status: accepted, 2026-09-19.

All cloud experiments use the same Python transport and persistent budget ledger. This avoids independent experiments accidentally overspending, keeps credentials out of the browser, and makes replays possible. The browser runs local inference and rendering; the loopback service owns cloud requests. Exact monetary reservations are conservative estimates, reconciled against returned gateway charges, with the account's existing limit as a second bound.
