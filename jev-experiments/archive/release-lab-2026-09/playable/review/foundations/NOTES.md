# Foundations independent review notes

- Root requested a bounded read-only review of runtime contracts/adapters, existing gateway/decoder fixes, publication verification and patch application scripts.
- Provider-free tests and temporary fixtures only. No model inference, training, GPU work or provider requests.
- The initial runtime suite passed nine tests. Independent fixtures then reproduced null-request throws, unchecked revisions, ordinal identity loss, null-provider rerolls, late cancellation success and an undeclared native prompt limit.
- Isolated the actual publication preservation function through Bun's TypeScript transpiler. It accepted changed empty-object shape. Temporary Git fixtures showed missing CI source allowed the patch before copy failure, while conflicting CI correctly stopped early.
- Root fixed all eight findings; independent after-fix probes confirmed the changes. Two adjacent direct-decoder fixtures exposed numeric string-enum acceptance and array probability containers; root fixed both.
- Added ten regressions without modifying implementation-owned files. Final run: nineteen tests passed, zero failed, sixty-one assertions.
- Read-only publication inventory ran through a temporary script/report location and passed all forty-five records. The first isolation attempt used an app symlink that broke lexical parent-result paths; replaced only the temporary script's path constants with absolute source paths and reran successfully. No root-owned report was overwritten.
- Inspected package/apply/clean-checkout scripts. Only api/route.ts is an untracked application file outside roadmap, and package-patch.py explicitly includes it.
- Independently reran all four Mac probes after owner fixes and retained post-fix evidence in the adjacent mac-toolkit review. Mac eight plus study five provider-free tests passed. Bounded review complete.
