# Shared typed decisions, version 2

The contract accepts state plus choice, boolean and ordinal questions. A successful response preserves every semantic value and probability, identifies the adapter/model/revision and records timing. Unsupported input, provider errors and cancellation are explicit results. Adapters declare limits. This layer does not truncate state or option lists.

`execute.ts` checks both sides of the adapter boundary. It rejects mismatched runtime identity, malformed distributions and late successes after cancellation. `jev.ts` translates the contract for hosted Jev without changing the question's meaning. Routing classifiers and the configured Mac bridge use the same types.

```ts
const result = await decide(adapter, {
  schemaVersion: "2",
  requestId: "notice-1",
  state: { notice: "Quiet reading until six." },
  questions: [{ id: "quiet", kind: "boolean", prompt: "Is this a quiet event?" }],
}, { signal });
```

Version 2 accepts strings, objects, arrays and null for instructions and descriptions. Ordinal `levels` describe each numeric value. Boolean `criteria` describe both boundaries. `selected` is a modal option; use `expected` for a continuous ordinal answer and `probabilityTrue` for a yes probability. Provider confidence is separate. Native values, legends, probability mass, usage, cost and reported model identity remain available when supplied. Missing provider identity is labeled `configured-unverified`.

This is a breaking contract. Version 1 requests return `error`; there is no conversion shim. Consumers must use the new schema and return distribution-derived summaries. The native parser and [MCP schema](../../packages/decision-runtime/src/request-schema.ts) preserve JSON structure.

The [Mac adapter](../routing/mac-adapter.ts) supports string prompts and option descriptions, eight options, 32 questions and 768 tokens per question. It rejects structured entries, boolean criteria and descriptive ordinal levels before inference. Its [Python runtime](../mac/jev_local.py) now uses the same version 2 wire format. No local failure triggers cloud execution.

The [source-slice verification](../../typed-runtime-2026-09-22/README.md) describes exact archived checks. Run the focused tests after frozen application, roadmap and TypeScript-adapter installs:

```sh
bun test jev-experiments/packages/decision-runtime jev-experiments/roadmap/runtime jev-experiments/roadmap/routing jev-experiments/adapters/typescript/index.test.ts
python3 -m unittest discover -s jev-experiments/roadmap/mac -p 'test_*.py'
```

The retained [original patch](existing-contracts.patch), [standalone verifier](verify-standalone.py) and [standalone report](standalone-check.json) describe version 1. Their hashes and outcomes remain unchanged. Use the source revision recorded in those artifacts to reproduce them; they do not verify this version 2 source.
