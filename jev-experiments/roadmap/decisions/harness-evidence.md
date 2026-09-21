# Prove client delegation with real tasks

- Owner: routing/integration
- Status: Resolved for bug/test/analysis; failure-path checks indexed separately
- Depends on: [Routing policy](routing-policy.md)

## Question

Do all three clients actually delegate, use returned artifacts through host permissions, and pass independent task tests?

## Resolution

OpenCode, Claude Code and Codex each invoked the MCP toolkit in isolated fixtures and completed bug repair, test writing and repository analysis. Record the real tool calls and resulting host diff, not initialization alone. Preserve unsuccessful setup variants separately and label their outcome. Per-client interruption and malformed-destination evidence are additional conditions, not inferred from a passing config parse.

## Evidence

[Integration protocol and evidence index](../integration/README.md), [client fixtures](../integration/evidence/).
