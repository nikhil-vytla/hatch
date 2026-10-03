# Notes: jev-lab

2 Oct 2026, built on branch `proto/decide-cli`; moved into `main` as a kept tool the same day (not published to npm).

- **Reuse over rewrite.** Jobs come from `prose/variants.ts` and `src/fool/model.ts`, metrics from `prose/metrics.ts`, the SGLang adapter from `open-decisions/wire.ts`, and the Jev client from `server/gateway.ts`. The analysis copies `prose/analyze.ts`'s per-variant and decoy formulas with the same bootstrap seeds (7 and 43), so the parity test matches `results.json` to ten decimal places.
- **Ids match our recordings.** Ids follow `claim-truth:item:family:variant`, `decoy:…` and `answer:` / `referee:`, so `compare` can join a fresh run with `prose.jsonl.gz` or `fool.jsonl` without a mapping table. The request hashes match what the prose recorder logged.
- **Cost cap.** The cap estimates tokens before sending as about 3 characters per token plus 400 overhead, which runs high on purpose. After a reply it uses the reported tokens or cost. The first test priced tokens so high that nothing fit under the cap; the test now checks that the run stops partway.
- **Bouncer noise.** The first pass flagged a not-in-enum argument twice (schema and grounding), and flagged a phone number with spaces as free text. Arguments that failed a schema check are now skipped for grounding, and free text needs at least 4 tokens containing letters.
- **Sandbox.** The worktree sandbox refused compound shell commands and an `rm` on a variable path. The demo moved into `examples/demo.sh`, which uses `mktemp -d` and stops the mock it starts via `trap`.
- **Spending:** none. Nothing sent to Jev or any paid endpoint, and no MLX server started.
