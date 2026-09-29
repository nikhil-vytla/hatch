import { expect, test } from "bun:test";
import type { LearningSignalsResult } from "@strive/protocol";
import { type Clock, type OfferDaemon, Offers } from "./offers";

/**
 * A daemon whose sessions have the signs `signs` says (a test may add more),
 * reporting only those past what a run or a dismissal dealt with, and
 * recording what it's asked to do.
 */
function daemon(signs: Record<string, number[]>) {
  const done: string[] = [];
  const dealt = new Map<string, number>();

  const d: OfferDaemon = {
    signals: async (session): Promise<LearningSignalsResult> => {
      const seqs = (signs[session] ?? []).filter((seq) => seq > (dealt.get(session) ?? 0));

      return {
        signals: seqs.map((seq) => ({ session, seq, kind: "correction", detail: "no" })),
        summary: seqs.length === 0 ? "" : `${seqs.length} corrections`,
        ask: seqs.length > 0,
      };
    },
    run: async (session) => {
      done.push(`run ${session}`);
      dealt.set(session, Math.max(0, ...(signs[session] ?? [])));
    },
    dismiss: async (session, through) => {
      done.push(`dismiss ${session} through ${through}`);
      dealt.set(session, through);
    },
  };

  return { d, done };
}

/** A clock whose timers run only when the test says time has passed. */
function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;

  const c: Clock = (run, ms) => {
    const id = next++;
    timers.set(id, { at: now + ms, run });

    return () => timers.delete(id);
  };

  const pass = async (ms: number) => {
    now += ms;

    for (const [id, t] of timers) {
      if (t.at > now) continue;
      timers.delete(id);
      t.run();
    }

    // What a timer started (a question to the daemon) settles.
    await Bun.sleep(0);
  };

  return { c, pass };
}

test("a session with signs is offered, and a clean one not at all", async () => {
  const { d, done } = daemon({ A: [4, 9], B: [3] });
  const offers = new Offers(d);
  await offers.consider("clean");
  expect(offers.current).toBeUndefined();

  await offers.consider("A");
  expect(offers.current?.session).toBe("A");
  // One at a time: B waits until A's is answered, and is considered again when it next goes idle.
  await offers.consider("B");
  expect(offers.current?.session).toBe("A");

  await offers.dismiss();
  expect(offers.current).toBeUndefined();
  expect(done).toEqual(["dismiss A through 9"]);
  // Nothing new since the dismissal: nothing to offer.
  await offers.consider("A");
  expect(offers.current).toBeUndefined();

  await offers.consider("B");
  await offers.learn();
  expect(done).toEqual(["dismiss A through 9", "run B"]);
  await offers.consider("B");
  expect(offers.current).toBeUndefined();
});

test("new signs after a dismissal are offered once more, and then not again in the window", async () => {
  const signs = { A: [4] };
  const { d, done } = daemon(signs);
  const offers = new Offers(d);
  await offers.consider("A");
  await offers.dismiss();

  signs.A.push(12);
  await offers.consider("A");
  expect(offers.current?.result.signals.map((s) => s.seq)).toEqual([12]);
  await offers.dismiss();

  signs.A.push(20);
  await offers.consider("A");
  expect(offers.current).toBeUndefined();
  expect(done).toEqual(["dismiss A through 4", "dismiss A through 12"]);
});

test("a session is offered once it has stayed idle after its turn ended, not at the turn's end", async () => {
  const { d } = daemon({ A: [4] });
  const { c, pass } = clock();
  const offers = new Offers(d, 60_000, c);

  offers.idle("A");
  await pass(59_000);
  expect(offers.current).toBeUndefined();

  // A new prompt within the minute: the wait starts over when that turn ends.
  offers.busy();
  await pass(5_000);
  expect(offers.current).toBeUndefined();
  offers.idle("A");
  await pass(30_000);
  expect(offers.current).toBeUndefined();
  await pass(30_000);
  expect(offers.current?.session).toBe("A");
});

test("switching away offers a session at once, and its idle timer no longer matters", async () => {
  const { d } = daemon({ A: [4] });
  const { c, pass } = clock();
  const offers = new Offers(d, 60_000, c);
  offers.idle("A");
  await offers.consider("A");
  expect(offers.current?.session).toBe("A");
  await offers.dismiss();
  await pass(60_000);
  expect(offers.current).toBeUndefined();
});

test("closing the window offers the session, and closes once the offer is answered", async () => {
  const { d } = daemon({ A: [4] });
  const offers = new Offers(d);
  let closed = 0;
  expect(await offers.beforeClose("clean", () => closed++)).toBe(false);

  expect(await offers.beforeClose("A", () => closed++)).toBe(true);
  expect(closed).toBe(0);
  await offers.learn();
  expect(closed).toBe(1);
});

test("a session asked about twice at once is offered once", async () => {
  const { d } = daemon({ A: [2] });
  const offers = new Offers(d);
  let changes = 0;
  offers.onChange(() => changes++);
  await Promise.all([offers.consider("A"), offers.consider("A")]);
  expect(changes).toBe(1);
});
