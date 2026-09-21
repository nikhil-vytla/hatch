# Mac toolkit independent review notes

- Bounded review requested by root: installer integrity, local-only inference, email parsing, declared limits, timing/output contracts, uninstall path handling and validation/test separation.
- Read-only with respect to the Mac and training implementations. No model inference, GPU use, training, downloads or provider requests are permitted during this review.
- Ran `test_local.py` and `test_study.py` through stdlib unittest: ten tests passed, including the complete 400-case / 2,000-question transfer corpus check.
- Read installer, uninstaller, model manifest, inference runtime, email evaluation, corpus preparation, readout fitting, robustness and complete-export bridge.
- Confirmed four defects with isolated provider-free fixtures. The predictable `.partial` destination followed a symlink and overwrote a sentinel; missing-model CLI response omitted required wire fields; tiny ordinal scales collapsed to zeros; stale tensors were relabeled by a rewritten feature manifest.
- Sent exact findings and evidence to root and training/runtime owner. Reported validation-only export eligibility, adapted decision timing and training-weight hash checks as additional gate gaps rather than observed test leakage.
- One attempted read targeted a nonexistent runtime/validate.ts; validation is implemented directly in runtime/contract.ts, which was read. No implementation changed during review.
- Owner reported fixes, then independent probes confirmed all four. Preserved post-fix output separately. Updated provider-free suites passed thirteen tests total, eight Mac and five study. No model or GPU work ran.
