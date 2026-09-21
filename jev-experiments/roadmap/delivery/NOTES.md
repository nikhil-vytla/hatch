# Delivery notes

- The repository requires authored artifacts and existing-code diffs under the work folder. Preserve the working application edits in `application.patch`; do not stage those outside files.
- GitHub main is `eb3c18d6db2891f0dfeff87d6a760d5936be37f4`. The working branch additionally has an earlier documentation commit, `d2c8ff3`; do not include that unrelated commit in the new PR slices.
- Plan five dependent review slices. Web components and the complete application patch belong to the final slice, so earlier toolkit slices do not import absent UI or release files.
- Standalone runtime verification uses an archived clean base and its two-file correction patch. Later slices will receive their own clean-checkout checks.

- Runtime draft PR [#58](https://github.com/nikhil-vytla/hatch/pull/58) starts at GitHub main, excluding the working branch's unrelated earlier documentation commit. Its Vercel and Vercel Preview Comments checks succeeded. Those checks build the unchanged canonical app, not the patch delivered by the final slice.
- The last Fable gate verified the exact requested model and found two routing edge cases. Publication of the dependent slices waits for their focused regression checks and another clean app build.
