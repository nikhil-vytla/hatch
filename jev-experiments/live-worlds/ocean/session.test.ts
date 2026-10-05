import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import shipped from "./policy.json";
import { evolved, jev, rule, type JevWire } from "./deciders";
import { fingerprint, type World } from "./engine";
import { JEV_BATCH, JEV_EVERY, LIVE_CAP, type jevRequest } from "./models";
import { parseRecording, type Recording } from "./replay";
import { createSession, RACE_SCENARIO, replaySession, type Asked, type Scenario, type Session, type Timing } from "./session";

/** Every tick's world, folded into one hash: positions, deaths, births, the RNG state and the decision count. */
const tickHash = (w: World) => `${fingerprint(w)}|${w.rng}|${w.decisions}`;

async function trace(s: Session) {
  const h = createHash("sha256");

  while (!s.done()) {
    const wait = s.step();

    if (wait) await wait;
    h.update(tickHash(s.world));
  }

  return h.digest("hex").slice(0, 16);
}

const heldout = (seed: number, event: Scenario["event"]): Scenario => ({ seed, event, eventAt: 15, seconds: 60 });

function run(scenario: Scenario, decider: Asked | null, timing: Timing | null) {
  const s = createSession(scenario);

  s.use(decider, timing);

  return s;
}

/** A Jev stand-in that answers at once: each fish's first option, or (`refuse`) an answer no fish can take. */
const instant =
  (sent: { n: number; inFlight: number; most: number }, opts: { refuse?: boolean; inputTokens?: number } = {}) =>
  async (req: ReturnType<typeof jevRequest>): Promise<JevWire> => {
    sent.n++;
    sent.inFlight++;
    sent.most = Math.max(sent.most, sent.inFlight);
    await Promise.resolve();
    sent.inFlight--;

    return {
      answers: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { value: opts.refuse ? "dance" : Object.keys(q.criteria)[0], probabilities: null }])),
      latency_ms: 0,
      usage: { input_tokens: opts.inputTokens ?? 6000 },
      served_by: "test",
    };
  };

/** Steps a live session through its scenario, letting answers arrive between steps as they would between frames. */
async function live(s: Session, onStep?: () => void) {
  while (!s.done()) {
    s.step();
    onStep?.();
    await new Promise((r) => setImmediate(r));
  }
}

describe("reef session: the same runs as before the session existed", () => {
  // Pinned from the code before the session module (lane F traces); a change here changes a published result or the replay.
  test("the committed Jev recording replays tick for tick", async () => {
    const rec = parseRecording(gunzipSync(readFileSync(new URL("./recordings/jev-heatwave.jsonl.gz", import.meta.url))).toString("utf8"));

    expect(await trace(replaySession(rec))).toBe("bb6c4dd451b5ef34");
  });

  test("the rule and the evolved policy on held-out seeds", async () => {
    expect(await trace(run(heldout(5000, "heatwave"), rule, { kind: "every", ticks: 3 }))).toBe("648f2f8c054d685c");
    expect(await trace(run(heldout(5001, "net"), evolved(shipped), { kind: "every", ticks: 3 }))).toBe("45290a0f74ae0fea");
    expect(await trace(run(heldout(5002, "oil"), evolved(shipped), { kind: "rate", perSecond: 5 }))).toBe("99783d006fb0cb58");
    expect(await trace(run(heldout(5003, "storm"), null, null))).toBe("779aa88ad6b903f7");
  });
});

describe("reef session: live asks are paced by the world, and capped", () => {
  const timing = { kind: "live", batch: JEV_BATCH, everyTicks: JEV_EVERY } as const;

  test("an instant decider gets one batch at a time, at most one every JEV_EVERY ticks: 200 in a 60 s run", async () => {
    for (const refuse of [false, true]) {
      // Refused answers leave every fish due: the case that used to ask back to back.
      const sent = { n: 0, inFlight: 0, most: 0 };
      const s = run(RACE_SCENARIO, jev(instant(sent, { refuse })), timing);

      await live(s);

      expect(sent.n).toBe(Math.ceil((RACE_SCENARIO.seconds * 30) / JEV_EVERY));
      expect(sent.n).toBe(200);
      expect(sent.most).toBe(1);
      expect(s.stats.requests).toBe(200);
    }
  });

  test("the page's cap holds a whole race, and stops a run that goes on", async () => {
    const sent = { n: 0, inFlight: 0, most: 0 };
    const race = run(RACE_SCENARIO, jev(instant(sent)), { ...timing, cap: LIVE_CAP });

    await live(race);
    expect(sent.n).toBeLessThanOrEqual(LIVE_CAP.requests);
    expect(race.stats.usd).toBeLessThan(LIVE_CAP.usd);

    const forever = run({ ...RACE_SCENARIO, seconds: 120 }, jev(instant(sent)), { ...timing, cap: LIVE_CAP });

    sent.n = 0;
    await live(forever);
    expect(sent.n).toBe(LIVE_CAP.requests);
    expect(forever.stopped).toEqual({ reason: "cap", cap: LIVE_CAP });
  });

  test("the spend cap stops a run before its request cap", async () => {
    const sent = { n: 0, inFlight: 0, most: 0 };
    // 10,000 tokens a request is $0.00042; the fifth request crosses $0.002.
    const s = run(RACE_SCENARIO, jev(instant(sent, { inputTokens: 10_000 })), { ...timing, cap: { requests: 100, usd: 0.002 } });

    await live(s);
    expect(sent.n).toBe(5);
    expect(s.stopped?.reason).toBe("cap");
  });

  test("a slow answer is followed at once, without waiting for another step", async () => {
    const releases: ((v: JevWire) => void)[] = [];
    const s = run(RACE_SCENARIO, jev(() => new Promise((r) => releases.push(r))), timing);

    for (let i = 0; i < JEV_EVERY + 3; i++) s.step();
    expect(releases).toHaveLength(1);
    releases[0]({ answers: {}, latency_ms: 400 });
    await new Promise((r) => setImmediate(r));
    expect(releases).toHaveLength(2);
    expect(s.inFlight).toBe(true);
  });

  test("a new run (use) resets the cap and drops an answer from the last one", async () => {
    let release: (v: JevWire) => void = () => {};
    const s = run(RACE_SCENARIO, jev(() => new Promise((r) => (release = r))), timing);

    s.step();
    expect(s.inFlight).toBe(true);
    s.use(rule, { kind: "every", ticks: 3 });
    release({ answers: {}, latency_ms: 0 });
    await new Promise((r) => setImmediate(r));
    expect(s.stats.requests).toBe(0);
    expect(s.inFlight).toBe(false);
  });

  test("a transport that throws stops the run's asking; the world keeps going", async () => {
    const s = run(RACE_SCENARIO, jev(async () => Promise.reject(new Error("key rejected"))), timing);

    await live(s);
    expect(s.stats.requests).toBe(1);
    expect(s.stopped?.reason).toBe("failed");
    expect(s.done()).toBe(true);
  });
});

describe("reef session: recording is a run with its log kept", () => {
  async function parity(timing: Timing, decider: Asked) {
    const s = createSession(RACE_SCENARIO, { keepLog: true });
    const seen: string[] = [];

    s.use(decider, timing);

    if (timing.kind === "live") await live(s, () => seen.push(tickHash(s.world)));
    else
      while (!s.done()) {
        s.step();
        seen.push(tickHash(s.world));
      }

    const rec: Recording = { seed: RACE_SCENARIO.seed, model: decider.name, recordedAt: "", seconds: RACE_SCENARIO.seconds, entries: s.log };
    const r = replaySession(rec);
    const replayed: string[] = [];

    while (!r.done()) {
      r.step();
      replayed.push(tickHash(r.world));
    }

    expect(s.log.some((e) => e.kind === "event")).toBe(true);
    expect(replayed).toEqual(seen);
  }

  test("a live Jev-shaped run replays tick for tick", () => parity({ kind: "live", batch: JEV_BATCH, everyTicks: JEV_EVERY }, jev(instant({ n: 0, inFlight: 0, most: 0 }))));

  test("an evolved-policy run replays tick for tick", () => parity({ kind: "every", ticks: 3 }, evolved(shipped)));
});
