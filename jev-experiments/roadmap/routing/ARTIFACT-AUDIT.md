# Routing artifact audit

The final artifact pass inspected 225 existing text files, totaling 1,260,889 bytes, across routing and integration before adding this report and the isolated verifier. The pass made no provider or GPU calls and did not rewrite measured records.

Credential scans found no matches for provider keys, AWS access IDs, GitHub tokens, JWTs, literal authorization headers or private-key markers. Exact matching against 11 available credential environment values also found no matches. All 633 JSON documents and JSONL rows parsed, and structured credential fields contained no unexpected literal values. These checks reduce accidental disclosure risk; they are not proof that arbitrary text can never contain a secret.

Home-directory paths occur 279 times in 17 retained evidence files. The four directly downloadable files with these paths are the OpenCode and Claude host transcripts, plus the Codex summary and host transcript. They contain this user-supplied hatch worktree and client skill/plugin installation paths. Those provenance paths remain unchanged.

The historical `integration/evidence/opencode-cwd-timeout/stdout.jsonl` also records a root directory listing at line 6 and a glob result at line 12. The latter names five unrelated files already tracked in this hatch repository: two parallax research scripts, an rl-env-filesystem summary and two strive demo ledgers. The transcript's read calls did not open those unrelated files. No separate private repository path or unrelated task content was found. This is part of the preserved directory-selection failure, not the successful public OpenCode transcript.

All 64 Markdown links checked had existing local targets. All 48 summary/transcript/audit references in the evidence index and all 21 Vite download imports resolve. The index still records 16 sessions, with 12 condition passes and 4 preserved failures. The official [OpenCode](https://opencode.ai/docs/mcp-servers/), [Claude](https://code.claude.com/docs/en/mcp) and [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) MCP documentation links returned content. The developers.openai.com Codex MCP URL redirects to the existing learn.chatgpt.com URL, so that link was left intact.

No current 59- or 60-test prose claim was found. The README, summary and delivery draft report 61 routing tests and 364 assertions. Earlier 41- and 56-test paragraphs in the review disposition now explicitly describe prior stages; chronological notes retain their original counts.

The separate [isolated check](isolated-check.json) archives Git base `d2c8ff30e9fa45008191ffd89273f87fdcc07f9b`, overlays the authored runtime and routing slice, applies the runtime's existing-code patch and copies only `mac/models.json` from the Mac toolkit. Two frozen Bun dependency installations, 78 combined runtime/router tests with 414 assertions, TypeScript and a fresh CLI installation passed. No training implementation, model weights, later app component or app handler was needed. The installer bundle matches the retained 83,629-byte build and checksum.

Run that provider-free check from the repository root:

```sh
python3 jev-experiments/roadmap/routing/verify-isolated.py
```

It writes a new local check report, records copied-source hashes and removes its temporary archive. It neither creates a branch nor commits code. Select a clean pre-runtime base with `--base` when the current Git HEAD already contains the runtime patch.
