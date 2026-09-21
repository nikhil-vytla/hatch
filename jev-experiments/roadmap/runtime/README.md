# One typed decision boundary

The contract accepts state plus choice, boolean and ordinal questions. A successful response preserves every semantic value and probability, identifies the actual adapter/model/revision, and records timing. Unsupported input, provider errors and cancellation are explicit results. Adapters declare limits; this layer does not truncate state or option lists.

`execute.ts` checks both sides of the adapter boundary. It rejects mismatched runtime identity, malformed distributions and late successes after cancellation. `jev.ts` translates the contract for hosted Jev without changing the question's meaning. Routing classifiers and the explicitly configured Mac bridge consume the same types.

```ts
const result = await decide(adapter, {
  schemaVersion: "1",
  requestId: "notice-1",
  state: { notice: "Quiet reading until six." },
  questions: [{ id: "quiet", kind: "boolean", prompt: "Is this a quiet event?" }],
}, { signal });
```

The [existing-code patch](existing-contracts.patch) fixes gateway and TypeScript adapter defects exposed by these tests: incomplete score vectors, inherited object keys, numeric choice identities and malformed response envelopes. This is a standalone review slice. The final `../application.patch` includes the same changes; apply either patch to its recorded clean base, not both in succession.

Run the standalone clean-source check from the repository root:

```sh
python3 jev-experiments/roadmap/runtime/verify-standalone.py
```

The command archives Git source, copies only this authored runtime folder, applies its two-file patch, installs the existing TypeScript adapter's locked dependencies and runs provider-free runtime tests. Its report records the base and patch hashes. It never calls a model provider.
