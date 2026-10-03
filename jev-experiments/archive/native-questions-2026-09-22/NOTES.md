# Native question delivery

- Selected the native JSON question definitions and language adapters as an independent source slice before the runtime and product wiring. The source was already implemented locally; this work makes it reviewable against a clean branch with current checks.
- Base is the reviewed publication-lineage PR, whose remote head and green checks were revalidated.
- Created the source commit in an isolated worktree; root HEAD and staged content remain unchanged.
- Excluded the later score-mapping and request-envelope helpers from this adapter slice because its imports do not require them.
- Verified the exact source archive. The app build preceded sibling installs; all eight command steps passed, including 45 public records.
- Independent Go/Rust execution used the identical archive. All adapter tests passed and the runner reported unchanged source and global configuration.
- Preserved the Python optional-test skip. These fixture tests establish interface behavior, not model quality or current host-client integration.
- Independent review passed 40 retained-evidence checks but found valid Choice/Noul legends rejected in Go/Rust. Preserved the first green condition and kept the PR draft while fixing it.
- Created a test-only Git fixture with the original implementations and new legend tests. Root's temporary official toolchains executed both suites and reproduced failure. This is separate from the owner's earlier launcher failure, which never compiled the tests.
- The corrected source's exact archive passes all eight build/contract/publication checks and both Go/Rust suites. Rust now executes 13 tests. All source and report versions remain separate.
