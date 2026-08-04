# Preregistration amendment: matched arm retired, reporting emphasis changed

Amends the preregistration digested as
`b2d987241252a19845ad5d0724e926109e6ad867d49474aeee473b1d6b6eff86`.

`preregistration.json` is **not** edited. Its digest is hashed into
`model_config_digest`, which is hashed into `design_digest`, which every family
and run row in the evidence carries. Editing the file would break that linkage
and invalidate the evidence it binds. Amendments go here instead.

## What changed

The instruction to retire the matched arm and report base (static) versus
evolved as the primary contrast arrived after construction had completed
(145/150 receipts, 139 admitted families, 863 paid provider calls) and before
any episode had run.

**The executed design is unchanged.** All three arms ran exactly as
preregistered. What changed is the reporting emphasis:

| | Preregistered | Reported |
|---|---|---|
| Primary contrast | evolved − matched | evolved − static |
| Secondary contrasts | evolved − static, matched − static | evolved − matched, matched − static |

No arm, source, trial, seed, budget, model, or analysis method changed. No
estimator or interval method was chosen after seeing outcomes; the same
source-clustered bootstrap declared in the preregistration is applied to every
contrast, and all three contrasts are reported. Only which one is labelled
primary changed, and it changed for a stated design reason rather than because
of an observed result — no outcome had been observed when the instruction
landed, because no episode had run.

## Why the matched arm is retired

The matched arm exists to license one specific causal claim: that a
static-versus-evolved difference is attributable to intent evolution rather
than to conversation length, because matched and evolved share turn count and
per-turn budget. That control is only worth its construction and execution cost
when the sample can actually support the attribution. At the sample sizes this
harness runs, it does not. Measured on this run, evolved − matched carries the
largest standard error of the three contrasts (0.0291, against 0.0260 for
evolved − static and 0.0222 for matched − static) and the widest interval
(0.116 wide, against 0.100 and 0.086), while carrying the smallest point
estimate (−0.023). It is also the only one of the three whose interval spans
zero. Paying roughly 45% of the episode budget for the least informative
contrast in the study is the wrong trade. Future designs run two arms, base
versus evolved.

The tradeoff is real and worth stating rather than glossing: the matched arm is
exactly what let this run decompose the −0.109 evolved − static gap into −0.086
from multi-turn presentation and −0.023 from intent evolution on top of it. A
two-arm design measures the total gap and cannot separate those. Retiring the
arm buys episode budget and gives up that decomposition.

## Why it was still executed here

Constructing the matched script is free — `_matched_turns()` renders locally off
the already-extracted source intent and issues no provider calls, so the
construction spend already paid is shared by all three arms. The avoidable cost
was matched's episodes only, roughly $4.50. Avoiding it would have required
breaking `ScriptFamily.controlled_arms`, `_build_manifest`,
`ManifestRecord.unique_design_units`, and `run_experiment`, all of which pin the
three-arm set — the same pin a concurrent restructure is removing. Trading
$4.50 for a merge conflict with an in-flight refactor, plus moving the evidence
off the package's audited write path, was not worth it. Executing the arm also
leaves the retired control with a final dataset, so the retirement rationale
above is argued from measurements rather than asserted.

## Note on the threshold field

`runner.ManifestRecord` still requires a `threshold` field to construct. It is
set to the fixed placeholder `0.0`, never read back, and carries no meaning in
this study. This study declares no threshold and returns no advance, reject, or
power verdict; it reports estimates and intervals as facts. `analysis.py` does
not import `parallax.report` and does not read `threshold`, `powered`, or
`action`.
