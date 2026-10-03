import { expect, test } from "bun:test";
import type { Entry, Event } from "@strive/protocol";
import { ancestry } from "./fork";

let seq = 0;

const at = (event: Event): Entry => ({ seq: ++seq, tsMs: 1000 + seq, event });

test("a fork's parents are followed back, oldest first, and none past a summary", async () => {
  const journals = new Map<string, Entry[]>([
    ["A", [at({ type: "userMessage", text: "in A" }), at({ type: "userMessage", text: "after the fork" })]],
    ["B", [at({ type: "forkedFrom", session: "A", seq: seq - 1 }), at({ type: "userMessage", text: "in B" })]],
  ]);

  const read = async (id: string) => journals.get(id)!;
  const own = [at({ type: "forkedFrom", session: "B", seq }), at({ type: "userMessage", text: "mine" })];
  const chain = await ancestry(own, read);

  expect(chain.map((c) => c.session)).toEqual(["A", "B"]);
  expect(chain[0]!.entries.map((e) => e.event)).toEqual([{ type: "userMessage", text: "in A" }]);
  const summarized = [...own, at({ type: "compacted", uptoSeq: seq, summary: "all of it" })];

  expect(await ancestry(summarized, read)).toEqual([]);
});
