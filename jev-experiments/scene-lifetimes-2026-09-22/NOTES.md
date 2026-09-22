# Scene lifetime fixes

Prepare an isolated delivery of eight scene cleanup fixes against canonical main. These fixes stop detached media and stale requests and preserve reading/replay state when effects reconnect. Browser retention evidence belongs to the separately integrated Activity shell; this PR will verify the component fixes independently.

## Implementation and verification

- Isolated the eight component changes on canonical main without copying the wider redesign or changing dependencies.
- Executed the maintained detached-ref regression against original source. It fails on the missing pause, rather than a missing callback shape.
- Carried the existing reviewed benchmark projection into the app build, with source-preservation, fail-closed and idempotence tests. The larger capability module reuses that function in the working tree.
- Built once before the projection extraction, then rebuilt and ran the selected suite after extraction. The exact committed Git archive also passed installation, production build and all 19 selected tests.
- Added a provider-free GitHub workflow. Actual CI and preview deployment results remain to be inspected after pushing.
- Kept the wider development shell's browser checks separate from this small PR's evidence.
