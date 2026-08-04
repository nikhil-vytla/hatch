The preregistered single-vs-evolved experiment ran to completion: 3 admitted
SWE-bench Verified boundary instances x 2 conditions x 3 paired trials, all
18 units verified by the pinned [official SWE-bench
harness](https://github.com/SWE-bench/SWE-bench) with Claude Opus 4.8 driven
through [HUD](https://hud.so)'s gateway under harness-owned turn delivery.
The paired single-minus-evolved pass-rate delta is +0.111 with
identification bounds [0.111, 0.111] and a minimum detectable effect of
1.57 over three source clusters — bounds-only, no advance/reject claim.
Getting there surfaced and fixed two real defects (strict-mode rejection of
JSON-wire delivery receipts; hud 0.6.12's 64 KiB frame limit destroying
paid episodes) and one HUD gateway instability window, each preserved as
failure evidence. Unique metered spend was $1.22 against the $2.73
estimate.

- Per-instance static-vs-evolved pass rates: astropy 2/3 vs 1/3, django 3/3
  vs 3/3, xarray 0/3 vs 0/3.
- All nine evolved delivery receipts show both scripted phases delivered
  (6+6 steps, no early-submission skips), confirming the manipulation
  landed in every evolved episode.
- The evolved condition was cheaper than static ($0.538 vs $0.567), so the
  preregistered 2x evolved cost multiplier was ~2x conservative.
