# Diff and security audit notes

## 2026-09-20

- The user asked where the roughly 285,000-line PR diff comes from and requested a security audit.
- Audit target: PR #54, branch `jev-experience-prototypes`, current deployed application in `experience-prototypes`, original runners and web implementation, and the browser companion.
- Begin with read-only analysis and local checks. Do not probe unrelated services or run destructive tests against production.
- Measured 284,666 added lines at the audited head. Recorded JSON contributes 260,219 lines, or 91.4%; full original and recovered snapshots and the earlier web implementation are both included.
- A round-tripped JSONL proposal for classification, games, and robustness reduced 195,716 lines to 1,359 while preserving every value. Source files and deployed data were not rewritten.
- Local mocked probes confirmed caller-controlled top-level gateway fields, full destination URL query/fragment forwarding, 100 sequential accepted evaluations, and eight simultaneous compositions. All provider calls in those probes were intercepted.
- Exact-value and signature scans found no exposed credentials in the three commits, public build, production asset graph, all 33 production JSON files, or extracted companion contents.
- Production endpoints rejected missing/wrong credentials; sensitive file paths returned 404. API preflight was blocked; static-site wildcard CORS does not authorize API access.
- The local Bun API binds to all network interfaces; lsof confirmed *:8793. Bearer authentication still applies.
- Current app and TS adapter npm audit returned no advisories. Legacy sharp and some local research dependencies have advisory matches. A Go reachability check could not run because Go was unavailable; the user clarified that exposed keys and actual attack vectors are the priority, so no new toolchain was installed.
- Existing six gateway tests passed, with 19 assertions. Report distinguishes authenticated abuse paths, privacy disclosure, development exposure, and optional hardening from an unauthenticated compromise.
