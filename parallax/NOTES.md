# Working notes

## 2026-08-02

- Started from `origin/main` commit `8746e20` on `cursor/parallax-upstream-characterization`.
- Scope is PR1 only: characterize the pinned Microsoft Evolving Intent implementation and published adapter asset feasibility. No production synthesis or experiment code belongs here.
- Treat the original evidence worktree as read-only. Verify every source revision and hash independently before recording it.
- Independently cloned `https://github.com/microsoft/evolving-intent`, detached at `993d6be9597ac03854b46362ccd647eb1bfd267a`, and verified tree `7ba418a8c6bddf5e650dc1808f7316a018d76168`.
- Recomputed Git blob SHA-1 and file SHA-256 values for the extraction, counterfactual, predecessor, trajectory, scheduler, renderer, SWE overlay, evaluator, license, and published evaluation-index files. The two old SWE scheduler hashes matched; the remaining hashes were derived fresh.
- Confirmed the observable upstream sequence: `BaseExtractor.extract`; `CounterfactualGenerator.generate_counterfactuals`; `PredecessorGenerator._generate_chain` with immediate-successor conditioning and fallback-model escalation; `create_sample`; `build_change_plan`; and `create_sample_swe`.
- Ran the pinned scheduler with a clearly labeled synthetic contract probe and deterministic prefix callables. The requested `(t=7, g=2, p=2)` probe retained six non-empty turns, followed farthest-to-nearest-to-source function order, and restored all source argument values and the final label.
- Confirmed the SWE overlay normalizes function punctuation, strips symptom arguments before generic scheduling, and installs a post-fill hook that redistributes and reinjects them by function phase.
- Confirmed all four committed evaluation ID manifests exist with counts GSM8K 200, BIRD-SQL 100, BrowseComp+ 100, and SWE-bench Verified 50. Every named generated source file under `final_dataset/` is absent.
- Confirmed `.gitignore` excludes Stage 1 output, counterfactual output, predecessor output, final datasets, external dataset directories, experiment outputs, workspaces, and logs.
- Asset review: GSM8K is MIT and light enough for a later native verifier slice. BIRD data is CC BY-SA 4.0 and needs large database packages. BrowseComp+ is MIT but obfuscated and needs external corpus/index assets plus an LLM judge after exact-match failure. SWE-bench is MIT at the harness level but needs Docker, instance images, source repositories, and target-repository licenses.
- The pinned dependency file is not an environment lock: it uses lower bounds and leaves `mini-swe-agent` unversioned.
- The old `parallax.frozen-proposal.v1` path is negative evidence. Its fixture has repeated-character digest placeholders and a `school_supply_sales` context unrelated to the Natalia source question. Its compiler appends the source question and checks a sentinel goal; it does not execute any upstream construction or scheduler stage.
- The characterization receipt contains no provider output or benchmark plaintext. Its contract probe uses symbolic tokens and is explicitly marked synthetic so it cannot be mistaken for generated benchmark data.
- Independent review found that the BIRD-SQL generator is not deterministic by default. The pin seeds one global RNG, but each sample shuffles candidate lists, the CLI defaults to four worker threads, and successful results append in future-completion order. Reproducibility therefore needs fixed inputs, database bytes, seed, worker count, runtime and later provider behavior, plus canonical output ordering.
- Replaced the shallow SWE check with an executable call to the pinned `_make_inject_hook`, followed by pinned `fill_texts` and `render_turns`. A synthetic slot layout deliberately leaks source and predecessor arguments across phases and leaves a phase-internal hole. The observed hook repairs ownership, refills the hole from the same phase, inserts all symptoms, sorts, and produces three locked rendered turns.
- The executable SWE probe exposed a narrower result than the earlier prose claimed. Symptoms are inserted at index zero, but the final category sort receives the stripped record, so symptom IDs lack category entries and sort after recognized categories. The report now records this exact behavior and drops the symptom-first rendering claim.
- Added a canonical SHA-256 over every receipt field and pinned it in the characterizer. Offline verification checks this seal and semantic invariants; the optional pinned-checkout test remains stronger because it regenerates the receipt by executing the pinned source.
- Final verification passed: offline receipt verification, 12 offline tests with the optional checkout test skipped, all 12 tests against the pinned checkout, `py_compile`, and `git diff --check`. The credential/private-path scan found only the intentional `/tmp/receipt.json` example, negative assertions for `/Users/` and `/tmp/`, and labeled synthetic or negative-evidence tokens. No credential, private trace ID, benchmark plaintext, hidden answer, or newly redistributed licensed asset was found.

## PR2 domain and verifier core

- Moved the PR1 subtree into `parallax/characterization/`. Product notes and the summary now have one durable home at `parallax/`.
- Added canonical UTF-8 JSON that rejects floats, non-NFC text, native paths, bytes, non-string keys, and integers outside the signed 64-bit range.
- Added typed immutable source, asset, verifier, public task, sealed task, grade, publication, tree snapshot, and replay-lock records.
- Bound native evaluator and parser source bytes, parser and evaluation policies, answer authority, assets, runtime policy, dependencies, and schemas into sealed identity.
- Implemented only the native GSM8K final-answer contract. The parser accepts one final canonical integer marker; malformed or ambiguous output is invalid.
- Added pre-execution admission checks for the exact asset set and bytes, local evaluator and parser implementation, answer authority, runtime policy, and sealed identity.
- Added same-filesystem staged publication, manifest verification, atomic rename, deterministic tree snapshots, and locked byte replay.
- Replay rejects changed or missing files, unexpected files, symlinks, non-regular entries, path escapes, changed verifier code, and changed assets.
- Core tests use only labeled synthetic prompts and answers. No benchmark plaintext or hidden answer is stored.
- Focused verification initially passed 13 core tests and 12 characterization tests with one optional pinned-checkout test skipped.
- Hardened tree replay to reject unexpected directories and a symlink used as the snapshot root; the core suite now has 14 tests.
- Final checks passed: 14 core tests, 12 characterization tests with one optional pinned-checkout refresh skipped, strict `mypy`, Ruff, `py_compile`, wheel build plus installed-wheel import, and `git diff --check`.
- The final content scan found no credential, private path, private key, trace ID, or benchmark answer. Numeric grading fixtures are explicitly labeled synthetic.
