# Malformed output fixture

Read `sum.ts` and `sum.test.ts`, then called the Jev `route_task` MCP tool exactly once with task ID `malformed-fixture`, a bug-fix prompt, both complete source files in context, and `outputTokens: 128`.

The tool returned `isError: true` and task status `error`. It selected route `malformed-local`; its single attempt had status `malformed`. The attempt error and outcome failure were both `Destination returned an invalid artifact.`

The exact raw output was:

```text
MALFORMED_FIXTURE_PAYLOAD
```

This output contains no usable patch or other artifact. I left `sum.ts` and all test files unchanged, as required by the fixture. I did not retry the tool, change routing restrictions, or edit configuration files. Tests were not run; the existing failing tests are expected and were not repaired.
