# Delivery notes

- The repository requires authored artifacts and existing-code diffs under the work folder. Preserve the working application edits in `application.patch`; do not stage those outside files.
- GitHub main is `eb3c18d6db2891f0dfeff87d6a760d5936be37f4`. The working branch additionally has an earlier documentation commit, `d2c8ff3`; do not include that unrelated commit in the new PR slices.
- Plan five dependent review slices. Web components and the complete application patch belong to the final slice, so earlier toolkit slices do not import absent UI or release files.
- Standalone runtime verification uses an archived clean base and its two-file correction patch. Later slices will receive their own clean-checkout checks.

- Runtime draft PR [#58](https://github.com/nikhil-vytla/hatch/pull/58) starts at GitHub main, excluding the working branch's unrelated earlier documentation commit. Its Vercel and Vercel Preview Comments checks succeeded. Those checks build the unchanged canonical app, not the patch delivered by the final slice.
- The last Fable gate verified the exact requested model and found two routing edge cases. Publication of the dependent slices waits for their focused regression checks and another clean app build.

- The five PRs are open at #58–#62. Runtime, routing, study, playable and integration source commits each contain only their selected roadmap files. Exact code commits and local checks are linked in README.md and pull-requests.json.
- The assembled study branch uses a fresh locked Python environment and no private corpus cache. Its one corpus-integration test skips as expected; nine unit tests, eleven Mac tests and the full committed-evidence/default audit pass. No model download or inference was repeated.
- The final assembled integration branch passed all eight clean-checkout commands, 45 byte comparisons, 61 evidence-asset checks and 98 shared tests. The clean verifier accepts an explicit working-build reference for artifact-only branches and captures its Git base before archiving.
- Final GitHub status snapshot records successful Vercel checks for all five initial heads. Only review documentation, cross-links and verification reports change in the final follow-up; the measured and checked implementation bytes stay frozen.
