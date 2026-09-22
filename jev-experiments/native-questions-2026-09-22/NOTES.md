# Native question delivery

- Selected the native JSON question definitions and language adapters as an independent source slice before the runtime and product wiring. The source was already implemented locally; this work makes it reviewable against a clean branch with current checks.
- Base is the reviewed publication-lineage PR, whose remote head and green checks were revalidated.
- Created the source commit in an isolated worktree; root HEAD and staged content remain unchanged.
- Excluded the later score-mapping and request-envelope helpers from this adapter slice because its imports do not require them.
- Verified the exact source archive. The app build preceded sibling installs; all eight command steps passed, including 45 public records.
- Independent Go/Rust execution used the identical archive. All adapter tests passed and the runner reported unchanged source and global configuration.
- Preserved the Python optional-test skip. These fixture tests establish interface behavior, not model quality or current host-client integration.
