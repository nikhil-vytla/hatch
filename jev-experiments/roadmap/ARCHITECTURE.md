# Keep the shared parts small

The first review after the routing and materials integrations found one useful extraction: HTTP destination execution had diverged between the web API and command-line tool. Both now call `routing/http-executor.ts`, so redirects, cancellation, usage validation, artifact parsing and identity reporting follow one implementation. Credentials remain invocation-specific; the browser uses unknown charge accounting while configured CLI routes can calculate list-price arithmetic.

The other immediate shared boundary is `runtime/contract.ts`. It defines typed questions, complete distributions, execution identity, limits and explicit failure states. Runtime adapters implement it without changing the selector. `runtime/execute.ts` rejects invalid inputs, mismatched revisions and late responses. The Mac bridge is explicit configuration, never an implicit local-to-cloud fallback.

The routing pipeline separates classification, hard eligibility, soft ranking, execution and outcome. A retained malformed model patch exposed a practical artifact issue. `routing/artifacts.ts` corrects only narrowly recognized hunk counts and records the exact original; the host still checks, applies and tests the proposal. This is code-owned format repair, not evidence that the original model artifact was valid.

Materials, crowd, music and Tetris retain their own simulation state, clocks, histories and legal actions. Their invalidation tokens look similar, but their acceptance boundaries differ: a material instruction changes a rule, a resident chooses a destination, music commits at a musical boundary, and Tetris acts while gravity continues. A universal experiment engine would obscure those differences. Each has concrete reset/edit/branch cancellation checks instead.

The study page loads its metrics and downloadable reports only when opened, rather than adding those evidence files to the homepage's initial bundle. Public JSON preparation shares one value-preservation check with its regression tests. That function lives in `verification/record-integrity.ts`; tests import it directly instead of parsing source-code formatting.

The eight runtime/gateway edge cases found by review now live beside the contract in `runtime/edge-cases.test.ts`. The independent review retains its original findings and before/after evidence. This lets the runtime review slice run its own regressions without importing the playable workstream.

No new animation, command-menu, physics or GPU dependency was added for the visual work. Existing React, Motion and canvas APIs support the current interactions. The research style study remains a standalone original artifact; it is not a second application framework. Rendering measurements must precede any new GPU infrastructure proposal.

The final catalog review removed the obsolete standalone handler-router branch from the older agent experiment component. Its four remaining variants now have explicit dispatch and a bounded ID type; all 41 catalog entries have a wired view. The micro agent still performs its separate tool-selection workflow.

Before release, recheck this document against the final dependency list, unused exports, evidence links and the independent review dispositions. Future extractions need at least two concrete consumers and must reduce the amount a maintainer needs to understand.

Production installation stays within the Vercel application root. Outside-root TSX modules use that application's React type declarations, and Vite deduplicates the React runtime. The canonical-root check builds before any toolkit or adapter dependency installation so sibling development packages cannot hide a deployment dependency. No duplicate React runtime or new deployment install step is required.
