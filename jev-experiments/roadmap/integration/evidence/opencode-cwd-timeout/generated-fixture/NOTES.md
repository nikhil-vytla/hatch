# Notes: OpenCode run of the Jev MCP integration fixture

- Working directory reported by the environment is the hatch repo root, not a
  generated `jev-opencode-*` temp dir. `sum.ts` and `sum.test.ts` do not exist
  there (checked with glob and a direct read).
- `evidence/opencode/mcp-audit.jsonl` shows only `initialize` + `tools/list`
  from this session so far, so the MCP server is connected.
- Decision: reconstruct the fixture byte-for-byte from the `SOURCE` and `TEST`
  constants in `run_harness.py` inside this folder, and do all work here.
- Bash is restricted to `bun test*`, `git diff*`, `git apply*`.
