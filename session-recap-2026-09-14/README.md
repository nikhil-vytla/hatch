# Previous session recap

The latest recorded work in this workspace was **Strive milestone 9**, committed as `dd6d458` on September 10, 2026 at 22:25 PDT. It connected the tau2 telecom campaign runner to real model calls and verified that its shared budget stops spending before the next call would exceed the cap.

The session also fixed network routing for token counting and generation. Both now use one trusted worker started before the Linux jail, while the agent remains confined. Transport failures have useful diagnostics and bounded timeouts.

The retained [live proof](../strive/live-results/runs/budget-stop-5c-egress/budget-proof.json) reports 34 calls, $0.0427922 spent under a $0.05 cap, zero overrun and zero dispatches after stopping. The campaign completed two episodes and suspended during the third. The [final transport report](../strive/tau2-egress-counting-fix/README.md) records 839 passing host tests, 26 skips, one expected failure and a passing strict type check.

Earlier [implementation notes](../strive/live-tau2-budget-proof/README.md) still describe the paid proof as pending. The final commit and saved result establish that it subsequently passed. A $5 pilot configuration was prepared; this recap did not find evidence that the larger pilot ran.

This identifies the latest recorded repository work, rather than reconstructing the previous chat transcript.
