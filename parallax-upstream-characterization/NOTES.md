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
