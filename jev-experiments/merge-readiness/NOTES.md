# PR #54 merge-readiness notes

## 2026-09-20

- The user authorized fixing the audit findings, converting recorded results to JSONL while continuing to serve/render JSON, updating PR #54, and reporting when it is ready to merge.
- A separate subagent is investigating a local-only Chrome paste mode for after merge. That investigation will not add experimental inference code to this PR.
- Work covers strict gateway payloads, private URL handling, shared API limits, explicit loopback binding, focused hardening, lossless result conversion, and production/browser verification.
- Scope correction from the user: shared usage limits are not required for this private lab. Stopped that work, removed the unused firewall SDK, and made no firewall configuration changes. The live UI currently uses a private lab token; it does not expose the gateway key or offer public access to that token.

- Product correction: the live playground must accept each visitor’s own Vercel AI Gateway API key. Replacing the private-token flow with caller-owned keys held only in browser memory, passed per request, with no environment-key fallback. Shared usage limits remain out of scope. Recording CLIs alone retain opt-in local credentials.

- All 33 generated public JSON documents match the pre-migration public snapshots exactly, including full benchmark inputs. Six original result files need their existing derived availability counts re-added during build preparation; those counts are now reproduced without upstream datasets or caches.
- The 15 focused Bun tests passed with 122 assertions, covering caller-key isolation, no environment fallback, strict request fields, retries, companion privacy/storage/disconnect, and TypeScript/Python JSONL interoperability.
- Restarted the owned Bun development server. `lsof` now reports `127.0.0.1:8793` instead of `*:8793`.
- Build verification initially ran from the wrong directory, and a later test-file creation used redundant path prefixes. Both were corrected, then the actual files and passing test count were checked. Papercut logging is not enabled in this repository, so no repository-level log was created.

- Production deployment `dpl_82mNPSvDBc3NhojBSjDz2AS8LkYc` completed at the canonical URL. An early live check raced the alias switch and hit the previous private-token deployment; it was discarded as a deployment-timing check, not a model result.
- Repeated automated production probes triggered Vercel's automatic ten-minute system challenge for the auditing client at 08:52 UTC. Firewall status confirms no custom firewall configuration, attack mode off, bot protection off, and no pending changes. No firewall setting was changed. Normal deployment protection on the immutable deployment requires owner authentication, so Vercel CLI generated its normal owner bypass token for verification. Neither credential is committed or printed.
- A live local check passed using the caller-supplied gateway key: 401 without a key, 400 for malformed input, 200 for evaluation, and a completed streamed UI edit that preserved the edited name and removed the requested toggle.
- Browser checks on the canonical app verified that the live form forwards the entered synthetic key, displays a rejected-key response, leaves local/session storage empty of that key, and supports disconnect. Reload clears the key. The request was intercepted only for this browser wiring check; real provider checks are recorded separately.

- All 17 focused tests now pass with 127 assertions, including friendly handling of a hosting challenge instead of a JSON parse error. Python's 10 tests and Ruff pass. The previous web application also builds against the JSONL reader.
- Production deployment `dpl_7MBzgNw8BMPkijBdhMPmVaK3d87m` contains the caller-key flow and improved hosting-error message. Owner-authenticated checks target its immutable URL, while the user-facing app remains at the canonical URL.

- Final scan after the implementation commit checked five commits, 293 unique blobs, 48 built files, four deployed assets, all 33 deployed JSON files, and companion ZIP contents. It found no actual credentials or matching secret signatures.
- Mobile QA at 390×844 found that the existing header hid the key button's text without an accessible name. Added an explicit aria-label. The light-mode dialog fits within the viewport and its key controls are accessible; desktop dark-mode was also visually inspected.
