# Sources and attribution

Read on 20 September 2026. No upstream source code was copied into this toolkit.

- [auto-model-router](https://github.com/fstandhartinger/auto-model-router), MIT licensed, informed task-boundary routing, separated classification/selection/outcome records, cache accounting, and distinct availability fallback versus quality escalation. This implementation deliberately rejects routes when no eligible candidate remains. Upstream measured findings are not Jev lab findings.
- [Whichmodel](https://whichmodel.app.mintapis.com/) informed the inspectable candidate table and separate cache simulation. Its page was retrieved directly after the web reader failed. Its published cost arithmetic and model scores were not imported into this registry.
- [OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/) specifies local command arrays under `mcp` and optional server timeout. [OpenCode CLI documentation](https://opencode.ai/docs/cli/) documents the explicit run directory used by the fixture runner.
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) specifies stdio `mcpServers` configuration and client tool permissions.
- [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) specifies stdio `mcp_servers`, tool timeouts, and per-tool approval modes. The fixture's explicit Jev approval configuration is scoped to that invocation. Distribution examples keep normal interactive prompting.
- [Vercel AI Gateway model catalog](https://ai-gateway.vercel.sh/v1/models) supplied the public model identifiers, context limits and list prices in web-registry.ts. Prices are dated, configuration values; they are not invoice observations. [Structured outputs documentation](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/structured-outputs) specifies the `json_schema` response format used after the first malformed web response.
