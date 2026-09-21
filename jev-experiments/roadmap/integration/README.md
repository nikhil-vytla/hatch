# Coding-client integration results

OpenCode, Claude Code and Codex each discovered the Jev MCP server, supplied task context, delegated a real bug fix and tests, used the returned artifacts, and passed independent Bun tests in generated fixture repositories. These were actual client sessions. JSON configuration parsing alone was not counted.

| Client | Version | Successful delegated tasks | Independent tests | Final run elapsed |
|---|---|---|---|---|
|OpenCode|1.18.31|Bug patch, test patch, structured repository analysis|10 passed,55 assertions|221.40s|
|Claude Code|2.1.278|Bug patch, test patch, structured repository analysis|5 passed,9 assertions|153.54s|
|Codex CLI|0.154.0|Bug patch, test patch, structured repository analysis|6 passed,9 assertions|110.16s|

These durations cover each full client session, not just the delegate. They are single observations with different host models and client behavior. Do not rank clients by these times. Claude used Sonnet 4.6 as its host after Fable access was rejected; OpenCode used Fable 5.1 Global through Bedrock. Codex used its configured default model. Every successful delegate used the configured Fable 5.1 Global destination. Its identity is configured-unverified because OpenCode's returned event stream did not separately attest the provider model. Cost remains unknown.

The fixture starts with an off-by-one loop that sums 1 through n exclusive. The independent original test fails before the host session and passes afterward. Returned tests run on the repaired source. The server never applies the patch or runs these tests. All final host changes, MCP audit records and sanitized transcripts are retained under evidence.

## Observed failures and recovery

- [OpenCode](evidence/opencode/summary.json) first used an unexpected effective project directory despite subprocess cwd, created a new contained fixture under the investigation folder, and timed out. The corrected run supplies `--dir` explicitly. Its first repository-analysis delegation failed to return a valid artifact; a later bounded analysis request succeeded. The host preserved and discussed the failure before applying the usable patches. The [original timed-out attempt](evidence/opencode-cwd-timeout/summary.json) remains visible.
- [Claude Code](evidence/claude/summary.json) discovered the tools on its first run, but the configured Fable host request was rejected by the provider's retention policy. That [unavailable host attempt](evidence/claude-fable-unavailable/summary.json) did not invoke a delegate. The corrected Sonnet host session did.
- [Codex](evidence/codex/summary.json) initially discovered and attempted the tools, but the normal MCP approval default rejected them under a noninteractive `never` policy. Those calls did not reach the server and are not successes. The corrected isolated invocation explicitly approves only `route_task` and `decide` through the documented per-tool configuration. The filesystem sandbox stays `workspace-write`. One malformed call omitted context and returned unsupported; the host retried with complete context while preserving its required-shell restriction.

Every corrected client also received an actual unavailable result for a required shell tool, and an unsupported typed-question result. None loosened the required-shell restriction to obtain a route. OpenCode additionally observed malformed delegate-output recovery. Separate actual-client suites now cover active interruption and deliberate malformed destination output in all three clients, as described below.

## Configure a client

Copy the matching example and replace the absolute paths. Keep credentials in the destination's environment or existing authenticated OpenCode installation.

- [OpenCode](examples/opencode.json) adds a local stdio command under `mcp`. The CLI fixture uses `--dir` to pin its repository.
- [Claude Code](examples/claude.mcp.json) uses a standard `mcpServers` entry. Load it through `--mcp-config` or the project's `.mcp.json`; retain the client's normal tool permissions.
- [Codex](examples/codex.toml) uses `mcp_servers`. The distributed example keeps interactive approval. The automated fixture scopes its explicit tool approvals to one invocation and two tools.

The short [jev-route-task skill](skills/jev-route-task/SKILL.md) explains complete-context delegation, artifact review, host-applied changes, independent tests and preserving no-route restrictions. It is client-neutral and can be placed in each client's supported skill folder. It passed the skill frontmatter validator.

Reproduce a fixture with `python3 jev-experiments/roadmap/integration/run_harness.py opencode --timeout 480 --evidence-name opencode-new-condition`, replacing `opencode` with `claude` or `codex`. A rerun writes a new temporary repository and refuses to overwrite retained evidence. These commands make real provider calls through installed clients and the configured destination. They do not publish a repository or send messages to people.

## Evidence boundaries

The task prompt, summaries and audit files are original experiment artifacts. No repository was fetched or copied. Host diffs and newly generated tests are kept instead of full fixture repository copies. Transcripts remove credential environment values and request/response headers before writing. The audit records context byte lengths but not private input text. These fixtures use only authored source and synthetic content.

Supported configuration syntax was checked against [OpenCode's MCP documentation](https://opencode.ai/docs/mcp-servers/), [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp), and [Codex's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Active interruption checks

A second isolated suite called a deterministic delayed loopback destination through each real client. The driver sent SIGINT only after the server audit recorded an active route_task call. All clients exited before the scheduled answer, with no returned artifact applied. OpenCode closed stdin; the server recorded client-disconnected and a cancelled result. Claude reported terminal_reason aborted_tools. Codex exited with its MCP call still marked in_progress. Claude/Codex did not leave server-side cancellation notifications, so none are claimed. See evidence/cancel-opencode, evidence/cancel-claude and evidence/cancel-codex. The MCP server now aborts outstanding delegates when its owning client disconnects.

This checks interruption of a live MCP call through actual clients, using a controlled destination. It does not measure a cloud provider's billed work after cancellation or a resumed interactive session after interruption.

## Evidence index and historical conditions

The generated [evidence index](evidence/index.json) lists each run in order of its first retained audit event, with client version, configured host model, raw transcript and audit links. Every summary contains `delegationOccurred`, requiring a successful route_task result with an artifact, and a condition-specific `evidenceGate`. Tool discovery alone never satisfies the delegation gate. `evidence_index.py` derives these annotations from the retained records without changing raw transcripts or measured outcomes.

The three original failure variants are marked failed in their own summaries. They are historical configurations, not modes offered by the corrected reproducer: OpenCode omitted explicit `--dir`, Claude used the unavailable Fable host, and Codex used the noninteractive default approval. Each failure directory was renamed before its corrected run. Command arguments preserve the audit pathname at the time of invocation; they do not mean the retained successful audit was later overwritten. Codex's default host model was not reported, so its identity remains unknown.

Current OpenCode fixture permissions pin `--dir` to the generated Git worktree, deny external directories, and allow relative read/edit patterns only for `sum.ts`, `*.test.ts` and `ANALYSIS.md`. Shell permissions allow only `bun test` and `git diff`; edits use the host's file tools. The same restriction applies at global and primary-agent scope. The first absolute-pattern refinement blocked legitimate reads/writes because OpenCode checks paths relative to its worktree; that failed condition is retained. The corrected pattern follows the [actual edit implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/edit.ts) and [permission documentation](https://opencode.ai/docs/permissions/).

## Malformed destination checks

[OpenCode](evidence/malformed-opencode/summary.json), [Claude Code](evidence/malformed-claude/summary.json) and [Codex](evidence/malformed-codex/summary.json) each actually called route_task against a loopback fixture that returned deliberately invalid artifact text. Every host observed an error, wrote an explanation and left the source and tests unchanged. The original failing test intentionally still fails in this condition. These are passes for safe error handling, not successful bug fixes. Run `malformed_harness.py` to reproduce after retaining the existing evidence under another name.

The interruption and malformed destinations are deterministic local fixtures; the coding clients and their host models were real. They make failure behavior repeatable without attributing synthetic destination behavior to a model.

## Unsupported task requests and unavailable routes

The [frozen boundary protocol](FAILURE-PROTOCOL.md) adds two actual route_task calls per client with complete authored source and tests. The empty-id request returns unsupported with a required-id explanation. A valid-id request against the empty local registry returns unavailable without widening eligibility. This unsupported condition checks invalid contract input; the earlier complete workflows separately exercised unsupported typed image questions and disallowed shell requirements.

| Client | Retained passing condition | Complete context per call | Observed results | Source and configuration |
|---|---|---|---|---|
|OpenCode|[Relative-path fixture](evidence/boundary-opencode-relative-paths/summary.json)|368bytes|unsupported, unavailable|Unchanged|
|Claude Code|[Boundary fixture](evidence/boundary-claude/summary.json)|367bytes|unsupported, unavailable|Unchanged|
|Codex|[Boundary fixture](evidence/boundary-codex/summary.json)|382bytes|unsupported, unavailable|Unchanged|

Each passing session made exactly two calls, returned readable explanations, recorded zero destination attempts, wrote its own ANALYSIS.md, and made no retry or reroute. Existing failing tests remained failing, as required. No delegated model or GPU ran. The clients used their authenticated host models; zero router execution cost does not include those host sessions.

The [first OpenCode boundary condition](evidence/boundary-opencode/summary.json) returned both expected statuses but could not write its explanation file because the absolute permission pattern did not match worktree-relative permission checks. It remains a failed gate. The corrected condition changed only fixture file permissions and kept the same task requests, empty registry and restrictions. The evidence index now contains16 sessions:12 condition passes and4 retained failures. Raw host explanations are observations, not accepted performance claims; single-call timing explanations in those files are not a measured causal result.

Reproduce a new condition with `python3 jev-experiments/roadmap/integration/boundary_harness.py opencode --evidence-suffix new-condition` (or claude/codex). Existing evidence is never overwritten. The protocol and generated per-run summaries distinguish these failure-handling passes from successful delegation of a coding task.
