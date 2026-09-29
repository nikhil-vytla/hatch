import { expect, test } from "bun:test";
import type { LearningSignalsResult } from "@strive/protocol";
import { type OfferDaemon, Offers } from "./offers";

/** A daemon whose sessions have the signs `signs` says, recording what it's asked to do. */
function daemon(signs: Record<string, number[]>) {
  const done: string[] = [];

  const d: OfferDaemon = {
    signals: async (session): Promise<LearningSignalsResult> => {
      const seqs = signs[session] ?? [];

      return {
        signals: seqs.map((seq) => ({ session, seq, kind: "correction", detail: "no" })),
        summary: seqs.length === 0 ? "" : `${seqs.length} corrections`,
        ask: seqs.length > 0,
      };
    },
    run: async (session) => {
      done.push(`run ${session}`);
    },
    dismiss: async (session, through) => {
      done.push(`dismiss ${session} through ${through}`);
    },
  };

  return { d, done };
}

test("a session with signs is offered once, and a clean one not at all", async () => {
  const { d, done } = daemon({ A: [4, 9], B: [3] });
  const offers = new Offers(d);
  await offers.consider("clean");
  expect(offers.current).toBeUndefined();

  await offers.consider("A");
  expect(offers.current?.session).toBe("A");
  // One at a time: B waits until A's is answered, and is considered again when its turn next ends.
  await offers.consider("B");
  expect(offers.current?.session).toBe("A");

  await offers.dismiss();
  expect(offers.current).toBeUndefined();
  expect(done).toEqual(["dismiss A through 9"]);

  // A has new signs by now, as far as the daemon says; the window doesn't offer it again.
  await offers.consider("A");
  expect(offers.current).toBeUndefined();

  await offers.consider("B");
  await offers.learn();
  expect(done).toEqual(["dismiss A through 9", "run B"]);
  await offers.consider("B");
  expect(offers.current).toBeUndefined();
});

test("a session asked about twice at once is offered once", async () => {
  const { d } = daemon({ A: [2] });
  const offers = new Offers(d);
  let changes = 0;
  offers.onChange(() => changes++);
  await Promise.all([offers.consider("A"), offers.consider("A")]);
  expect(changes).toBe(1);
});
