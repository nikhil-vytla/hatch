# Jev diff size and security audit

Audited PR #54 at `f6926cc548682df8ac5921b09c02d5ad0f0aed13` on September 20, 2026. The user's priority is exposed credentials and reachable attack paths. This is an audit and a proposed data-format measurement; application code, result formats, and the deployment have not been changed.


## Remediation update for PR #54

The findings below describe the original `f6926cc` deployment. The [merge-readiness report](../merge-readiness/README.md) tracks the fixes and current verification. Live requests now use each visitor's own Vercel AI Gateway key, with no server-environment fallback. The website keeps keys in memory; the extension stores the visitor's key in trusted extension storage and provides Disconnect. Payload forwarding is restricted, page URLs are omitted from model requests, the development server binds to loopback, public data has an explicit allowlist, and framing is blocked. Shared limits are deliberately out of scope at the user's direction.

All 38 result files have been converted to JSONL, while the 33 published JSON documents retain their original values and complete benchmark text. The original audit evidence and line counts below remain historical; current measurements are recorded separately. `local-probes.ts` now runs the remediation tests; the original reproduction code is preserved at commit `49a46b7`.

## Where the diff comes from

The PR adds 177 files, 284,666 text lines, and 14.95 MB of file content. Recorded JSON results account for **260,219 lines, or 91.4%**. The large count mostly comes from pretty-printing probability distributions, case records, transport metadata, and individual game frames across many lines. The earlier application and the rebuilt application are both retained, as are original and recovered result snapshots.

| Category | Added lines |
| --- | ---: |
| Recorded results | 260,219 |
| Current application | 11,532 |
| Research runners, adapters, and tests | 5,288 |
| Earlier application | 3,829 |
| Lockfiles | 3,018 |
| Reports, configuration, and artifacts | 780 |
| Total | 284,666 |

All three commits introduce a new investigation folder relative to `main`, so GitHub counts the full files. These numbers describe the audited application commits, before this audit report. Binary contents do not contribute text lines.

## What JSONL would change

A proposed tagged JSONL representation stores one case, episode, observation, or metadata record per line. Encoding and decoding it reproduced every value in each of the three largest JSON files.

| File | Current JSON lines | Proposed JSONL lines |
| --- | ---: | ---: |
| `results/classify.json` | 95,473 | 788 |
| `results/games.json` | 84,041 | 370 |
| `results/robustness.json` | 16,202 | 201 |
| Total | 195,716 | 1,359 |

Converting just those files would reduce the original PR's net additions to about **90,309 lines**. Their combined size falls from 6.12 MB to 3.39 MB, mostly by removing whitespace. This is a measured format proposal, not an implemented migration. Very long records remain long lines; JSONL does not remove duplicate snapshots or make every numeric change easy to review.

Recommended implementation: keep complete records in JSONL, retain compact human-readable summaries, and decode them into the existing runtime JSON during build preparation. Benchmark text and game playback would remain available. Removing the superseded `web` implementation and deduplicating unchanged original/recovered records are separate cleanup opportunities. Marking generated evidence in `.gitattributes` would improve review but would not reduce repository size. Source files, validation, and API changes should remain fully visible in review.

## Credential and public-access checks

**No exposed gateway key, private lab token, or tested authentication bypass was found.**

- Exact-value scans checked the real gateway key and private lab token without printing either value. Scanned all three application commits, 183 unique committed blobs, 48 local built public files, four production JS/CSS assets, all 33 published JSON data files, and the extracted public browser-companion ZIP.
- Additional signature checks looked for GitHub tokens, OpenAI-style keys, AWS access keys, Vercel tokens, and private-key blocks. They returned no matches.
- Production requests to `.env`, `.env.local`, `.git/config`, `.vercel/project.json`, server source, credential-loading source, and excluded access/smoke records returned 404.
- Both production API endpoints returned 401 without a token and with an incorrect token. GET returned 405. API cross-origin preflight returned 405 and no permissive CORS header. The public static homepage has wildcard CORS, which does not expose the authenticated API.
- The gateway URL is fixed, and the gateway credential is added server-side. Clients use a manually supplied private lab token; the gateway credential stays server-side. The app stores that token in session storage; the extension stores it locally. Model responses are rendered as React text or DOM `textContent`, with an explicit component/action catalog. I did not identify a reachable arbitrary-HTML, script-execution, or caller-selected URL-fetch path in the current deployed application.

These checks cover the known credentials and signatures above; they are not a claim that every possible secret format or browser exploit has been exhaustively tested. No load testing, malicious-model loading, or exploit attempts against the upstream provider were performed.

## Actionable findings

### 1. Medium: authenticated callers can override the gateway request's model and add provider fields

Location: [gateway.ts:139](../experience-prototypes/server/gateway.ts#L139), with permissive top-level validation starting at line 27.

`JSON.stringify({ model: "typesafe-ai/jev", ...body })` lets an incoming `model` replace the fixed value. Unrecognized top-level fields also pass through. A local mock confirmed both a different model name and extra gateway settings reached the outbound request. This requires a valid lab token; it is not an authentication bypass. The native endpoint's acceptance of a different model was deliberately not tested, so arbitrary model execution is not claimed.

Fix: construct the provider request from exactly `model`, validated `state`, and validated `questions`, and reject unknown request/question keys. Add a regression test showing that supplied model or routing settings cannot alter the outgoing payload. The older handler already constructs these fields explicitly.

### 2. Medium: the paste companion forwards destination URL secrets to the provider

Location: [background.js:71](../experience-prototypes/extension/background.js#L71).

The request includes the complete `sender.tab.url`. A local mock confirmed that both a query token and a fragment token were sent with a paste request. Password-reset links, signed URLs, or authentication callbacks can carry secrets in those positions. This is unintended disclosure to the configured lab/provider, not evidence that a third-party site has stolen the lab key. No real URL token was used in the reproduction.

Fix: omit the URL unless needed. If destination identity helps matching, send only `new URL(url).origin`; paths can contain secrets too. Continue using field labels and types for the matching task. Review source-URL retention as well, because the companion keeps the full captured URL locally.

### 3. Medium, conditional on a valid or leaked lab token: no shared usage limits for live endpoints

Locations: [evaluate.ts:14](../experience-prototypes/api/evaluate.ts#L14), [compose.ts:3](../experience-prototypes/api/compose.ts#L3), and [server/compose.ts:32](../experience-prototypes/server/compose.ts#L32).

Evaluation has a six-request concurrency limit in one warm function, with no shared rate or spending ceiling. Composition has no corresponding concurrency limit and can make up to 32 decision steps per request. A local mocked run accepted 100 sequential evaluations and eight simultaneous composition calls. The Python runner's SQLite budget does not govern these deployed endpoints. No production traffic burst was used to demonstrate this.

Fix: use a generously sized shared concurrency/rate limit, scoped tokens that can be revoked individually, and an account-level spending backstop. The purpose is to contain misuse and preserve availability if a token leaks, not to make cheap Jev calls scarce. Existing provider/account controls may reduce impact, but they were not audited here.

### 4. Low: the development API listens on all interfaces despite its loopback message

Location: [server/dev.ts:23](../experience-prototypes/server/dev.ts#L23).

`Bun.serve` has no `hostname`. Its [documented default is `0.0.0.0`](https://bun.com/docs/runtime/http/server), and `lsof` showed the running process on `*:8793`. The server still requires the lab token, so this alone does not grant gateway access. It unnecessarily exposes a development service to reachable network peers.

Fix: set `hostname: "127.0.0.1"` explicitly.

## Additional hardening

- Production sends HSTS, `nosniff`, and a restrictive referrer policy, but no Content Security Policy or frame restriction. Add an application-compatible CSP and `frame-ancestors 'none'` unless embedding is intended. This is defense in depth; an exploitable XSS path was not identified.
- Restrict extension storage to `TRUSTED_CONTEXTS` and provide an explicit disconnect action that clears the lab token. Chrome exposes `storage.local` to extension content scripts by default, as documented in [the storage API](https://developer.chrome.com/docs/extensions/reference/api/storage). That does **not** mean ordinary page JavaScript can read it; content-script isolation still applies.
- Build preparation publishes every JSON file in the results directories except a short exclusion list. Use an explicit publication manifest and scan the prepared output for secrets before deploying. No leaked credential was found in the current published records.

## Dependency checks, kept separate from reachable findings

`bun audit --json` reported no advisories for the current application or TypeScript adapter. The superseded `web` lockfile includes `sharp@0.34.5`, which has two high-severity advisory entries about image-decoding dependencies: [libvips advisory](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) and [libheif advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). `sharp` is absent from the current application; no deployed vulnerable image-processing route was identified.

An exact-version OSV scan covered 114 Python, Rust, and Go packages. It returned version matches for NLTK, Torch, Transformers, and five Go modules, with no Rust matches. Duplicate advisory aliases are not counted as distinct exploits. These local research dependencies warrant an update pass, but those matches are not evidence of a remote exploit in the deployed Vercel app. Go symbol-reachability analysis was not completed because Go was unavailable in this shell; it was not installed during this audit. Raw advisory dumps are excluded from the audit commit.

## Reproduction and evidence

Run from the repository root:

```sh
python3 jev-experiments/security-audit/diff-analysis.py
bun jev-experiments/security-audit/local-probes.ts
bun jev-experiments/security-audit/secret-scan.ts
bun jev-experiments/security-audit/public-surface.ts
```

The local probes use fake credentials and intercept every provider request. The secret scan reads the owner's authorized local credentials privately and reports only counts and filenames. Public-surface checks make small unauthenticated requests to the authorized app. The existing six gateway tests also pass, covering 19 assertions.

Machine-readable evidence is in `diff-breakdown.json`, `jsonl-estimate.json`, `local-probe-results.json`, `secret-scan-results.json`, `public-surface-results.json`, and the three small npm audit outputs. These artifacts describe the original audit. See the linked merge-readiness report for remediation checks.
