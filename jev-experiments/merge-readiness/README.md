# PR #54 merge readiness

The live playground now accepts each visitor's own Vercel AI Gateway API key. The website keeps it in page memory, clears it on reload or disconnect, and passes it per request through the app to the fixed Jev endpoint. Neither live endpoint reads the owner's environment key. Shared usage limits are intentionally out of scope.

The canonical app remains [jev-experiments.vercel.app](https://jev-experiments.vercel.app). The paste companion follows the same caller-key flow, with an explicit connection action, trusted extension storage, and a Disconnect button that removes the saved key. This is the existing cloud-backed companion; local-only inference is a separate post-merge investigation.

## Fixes

- Only supported request fields reach the provider, and callers cannot override the fixed model or pass extra gateway settings. Request sizes are checked in UTF-8 bytes.
- Provider authorization errors do not echo response bodies. Unexpected HTML responses show a useful retry/reload message.
- Companion requests omit source and destination URLs. Source attribution retains only the origin; previously stored full URLs are reduced to origins. The background worker validates the sender and field descriptions before reading stored facts.
- The development API binds to `127.0.0.1`. Production adds framing, object, and base-URL restrictions.
- `publication.json` explicitly lists public evidence. Unlisted files in `public/data` fail preparation. No firewall rules or shared quota infrastructure were added.

## JSONL storage, JSON experience

All 38 recorded result documents are now JSONL. The `jev-records-v1` header stores the original object structure with empty arrays, followed by ordered `{path, index, value}` entries, one array item per line. TypeScript and Python readers reconstruct the original JSON. Recording tools, recovery, metrics, the Python report command, and both application build scripts use the new format.

Thirty-seven source documents are exactly equal to their original JSON. Classification evidence also includes the already-published input text that previously depended on a local dataset cache, with predictions, targets, probabilities, and recovery metadata unchanged. All 33 built public JSON documents are exactly equal to their pre-migration public snapshots. Full JudgeBench questions and both candidate answers remain visible and downloadable. No model decisions were rerun for this conversion.

The original audited application added 284,666 lines, including 260,219 lines of recorded results. The converted result files use 8,383 lines. The complete updated PR is approximately 35,000 added lines, including the new audit and verification material. JSONL removes formatting overhead; it does not remove evidence or earlier snapshots, and individual records can still be long lines.

## Verification

- `bun test server`: 17 tests, 127 assertions. Covers separate caller keys under concurrency, absence of an environment-key fallback, request validation, retries, companion storage/privacy/disconnect, readable hosting errors, and JSONL interoperability.
- Python: 10 tests pass; Ruff passes. Current and preceding application production builds pass with Bun.
- `verify-evidence.ts`: all 38 documents round-trip in TypeScript and Python; all 33 published JSON snapshots match; an unlisted public file is rejected.
- The restarted development listener was verified with `lsof` as `127.0.0.1:8793`.
- Browser checks cover API-key entry, request forwarding, disconnect, reload clearing, absence of the key in local/session storage, and the dark-mode dialog. A synthetic key was used for browser wiring; real provider checks are separate.
- Live checks exercise both evaluation and composition with a caller-supplied gateway key: missing key 401, malformed request 400, valid judgment 200, and a completed UI revision that preserves an edited name while removing the requested toggle. Owner-authenticated checks buffer the HTTP body, so their first-chunk timing is deliberately omitted.
- Public checks found the tested secret/source paths unavailable, both API GETs rejected, missing or malformed credentials rejected, an invalid caller key rejected by the provider, and the expected framing headers.

The automated audit requests triggered Vercel's ten-minute system challenge for the auditing client. Firewall status showed no custom configuration or pending changes. Owner-authenticated CLI access was used to inspect the immutable production deployment without changing firewall settings. This distinguishes the hosting challenge from application authentication. The final scan records its access mode and exact deployment URL.

The credential scan checks the owner's exact gateway key and former lab token, known secret signatures, committed history, staged changes, built files, deployed assets, all 33 published JSON files, and the extracted companion ZIP. See `secret-scan.json`, `public-check.json`, `live-check.jsonl`, and `evidence-verification.json` for results. The [original audit](../security-audit/README.md) preserves the pre-fix findings.

## Reproduce

From `experience-prototypes/`:

```sh
bun test server
bun run build
bun ../merge-readiness/verify-evidence.ts
bun scripts/cloudcheck.ts https://jev-experiments.vercel.app ../merge-readiness/live-check.jsonl
```

From the repository root:

```sh
bun jev-experiments/merge-readiness/public-check.ts
bun jev-experiments/security-audit/secret-scan.ts
```

The live check explicitly uses the locally authorized `AI_GATEWAY_API_KEY` as the caller's key. The scan reads authorized credentials privately and reports only counts and filenames. For a protected immutable deployment, `check-protected-deployment.ts URL` and the scanner's `--owner --origin=URL` use Vercel CLI owner authentication; no credential values are written into reports.

Chrome installation and unusual website widgets still need broader compatibility testing. Extension regression checks use a synthetic Chrome runtime and do not establish compatibility with every website. The audit is focused on exposed keys and identified attack paths, not a guarantee against every possible vulnerability.
