# Native gateway and observed accounting

- Deliver the native HTTP gateway, Score agreement checks, and shared request accounting on top of the native-question adapter PR.
- Keep the typed runtime envelope, routing integration, and scene redesign in their own source slices.
- Preserve observed model identity, partial usage, paid failures, and unknown earlier attempts. A successful final response is not proof of a known total cost.
- Reuse the existing independently enumerated Score interval tests and add direct gateway tests that do not depend on the later runtime envelope.

- The first exact archive built successfully and passed 29 tests before the decoder suite could import its missing sibling Zod dependency. Preserved the failed condition and verifier. Added the adapter frozen install after the application build in CI and the verifier; product source is unchanged.
- The corrected exact archive passes all five verification steps: app install/build, adapter install, 31 focused tests with 948 assertions, and all 45 publication checks. No provider calls or new model measurements were requested.
- Independent review of that source found final-observer cancellation, undispatched-attempt counting and partial-token coherence defects. Preserved four failing regressions and two passing controls against the reviewed source.
- Corrected all three issues and added pre-dispatch abort/earlier-attempt coverage. The new exact archive passes 38 tests with 981 assertions and all five verification steps. Independent correction review adds 18 boundary cases with 164 passing assertions; prior review artifacts remain unchanged.
