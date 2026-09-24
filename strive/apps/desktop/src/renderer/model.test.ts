import { expect, test } from "bun:test";
import type { Entry, Event } from "@strive/protocol";
import { SessionModel } from "./model";

let seq = 0;

const at = (event: Event): Entry => ({ seq: ++seq, tsMs: 0, event });

test("checkpoints are labelled with the prompt they came before, and rewinds with where they went", () => {
  const m = new SessionModel("s1");
  m.apply(at({ type: "checkpointed", checkpoint: 1, commit: "a" }));
  m.apply(at({ type: "userMessage", text: "fix it" }));
  m.apply(at({ type: "checkpointed", checkpoint: 2, commit: "b" }));
  m.apply(at({ type: "rewound", to: 1, savedAs: 2 }));
  expect(m.checkpoints).toEqual([
    { n: 1, label: "before “fix it”" },
    { n: 2, label: "before rewinding to 1" },
  ]);
});

test("an entry seen twice counts once", () => {
  const m = new SessionModel("s1");
  const said = at({ type: "userMessage", text: "hi" });
  m.apply(said);
  expect(m.apply(said)).toBe(false);
  expect(m.conversation.items).toHaveLength(1);
});

test("activity shows each effect and how it ended", () => {
  const m = new SessionModel("s1");
  m.apply(
    at({ type: "effectStarted", effect: 1, callId: "c", record: { kind: "bash", command: "false", timeoutMs: 1 } }),
  );
  m.apply(at({ type: "effectFinished", effect: 1, outcome: { kind: "refused", reason: "no" }, durationMs: 1 }));
  expect(m.activity).toEqual([{ effect: 1, what: "$ false", outcome: "refused" }]);
});

test("a prompt knows the checkpoint taken just before it, and one sent without a checkpoint has none", () => {
  const m = new SessionModel("s1");
  m.apply(at({ type: "checkpointed", checkpoint: 1, commit: "a" }));
  const first = at({ type: "userMessage", text: "one" });
  m.apply(first);
  const second = at({ type: "userMessage", text: "two" });
  m.apply(second);
  m.apply(at({ type: "checkpointed", checkpoint: 2, commit: "b" }));
  const third = at({ type: "userMessage", text: "three" });
  m.apply(third);
  expect([m.before.get(first.seq), m.before.get(second.seq), m.before.get(third.seq)]).toEqual([1, undefined, 2]);
});
