# Technical debt

Known compromises in v0, with the intended fix. None are load-bearing enough
to block the next milestones; all were accepted deliberately (KISS).

1. **`no_secret_leak` is a substring heuristic.** Attribute name + long string
   values only. Real leak detection needs an LLM-judge verifier with
   ground-truth access (M2). The contract interface won't change.
2. **Verification is post-hoc.** Verifiers scan the finished trace. Long-running
   worlds want streaming verification (incremental fold, same predicates) so a
   violated invariant can halt a run early. Interface already permits it.
3. **Replay divergence is detected, not explained.** On fingerprint mismatch we
   raise; we should diff the two event logs and report the first divergent
   event with both versions (small, high-value debugging win).
4. **`finally_state` verifiers aren't reachable from TOML contracts.** State
   predicates are Python-only; contract items currently cover event patterns.
   Either add a small state-query param language or accept Python-only for
   state checks (leaning: keep Python, document).
5. **Observation cursors assume single-threaded stepping.** Fine for the v0
   kernel; parallel policy evaluation (U3) will need per-activation event
   ranges captured at schedule time instead of a mutable cursor.
6. **No OpenTelemetry yet.** Structured JSON logging is in; OTel spans around
   activation/decide/submit would drop in at `engine.run` without touching
   call sites. Deferred until there's a consumer.
7. **Trace stores decisions inline and unbounded.** Fine at v0 scale (<10^5
   events). Long timelines need segment files + periodic snapshots (U9) and
   possibly the verifiers-v1 prefix-collapsed message graph for LLM contexts.
8. **`RunResult.passed` treats objectives and invariants alike.** Reporting
   should distinguish "unsafe" (invariant broken) from "unsuccessful"
   (objective missed); the data is present on ContractItem.kind, the rollup
   ignores it.
9. **`uses` executes arbitrary module imports.** Acceptable for a local research
   tool; a hosted service would need an allowlist/sandbox around domain packs.
10. **ModelPolicy history is flattened text.** Tool calls/results are
    serialized into plain turns — provider-portable and replay-safe, but it
    discards native tool-use message structure, which degrades strong
    tool-calling models. Fix: store structured turns, render per-client
    (`ModelClient` interface unchanged). Do this before any serious live-model
    evaluation (M3).
11. **`AnthropicClient` is untested against the live API.** Playbook covers
    ModelPolicy logic and replay never needs a provider, but the ~40 lines of
    request/response conversion have no integration test (requires a key).
    Add an opt-in `ANTHROPIC_API_KEY`-gated smoke test.
12. **Adapter arg-matching is exact.** `payload_contains` equality vs. BFCL's
    accepted-answer ranges; needs a `matches_any`/predicate param at M4.
