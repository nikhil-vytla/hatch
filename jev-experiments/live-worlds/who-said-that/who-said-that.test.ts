import { describe, expect, test } from "bun:test";
import { ALL_ON, countOdds, counts, decide, hindsight, SIGNALS } from "./decide";
import { freeAnswers, freeReplyTo, fromJev, jevRequest, type TextAnswers } from "./questions";
import { accuracy, attribute, match, score, type Truth } from "./score";
import { listen, splitLong, type Heard, type Models } from "./signals";
import { markdown, renumber } from "./transcript";

const unit = (v: number[]) => {
  const n = Math.hypot(...v) || 1;

  return v.map((x) => x / n);
};

/** A line with a voice and a meaning drawn from a few fixed directions, plus a little noise. */
function line(i: number, voice: number, topic: number, extra: Partial<Heard> = {}): Heard {
  const v = Array.from({ length: 8 }, (_, k) => (k === voice ? 1 : 0) + 0.05 * Math.sin(i * 7 + k));
  const m = Array.from({ length: 8 }, (_, k) => (k === topic ? 1 : 0) + 0.05 * Math.cos(i * 3 + k));

  return { start: i * 2, end: i * 2 + 1.5, text: `line ${i} and so on`, voice: unit(v), meaning: unit(m), db: -20, ...extra };
}

describe("questions", () => {
  test("free reply odds cover every earlier line plus none, and sum to one", () => {
    const h = [line(0, 0, 0), line(1, 1, 0), line(2, 0, 0)];
    const p = freeReplyTo(h.slice(0, 2), h[2]);

    expect(p.length).toBe(3);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  test("the first line's request has no reply question (a choice needs two options)", () => {
    const h = [line(0, 0, 0), line(1, 1, 0), line(2, 0, 0)];

    expect(Object.keys(jevRequest(h, 0).questions).sort()).toEqual(["continues", "newTopic"]);
    expect(Object.keys((jevRequest(h, 2).questions as { replyTo: { criteria: object } }).replyTo.criteria)).toEqual(["L1", "L2", "none"]);
  });

  test("Jev's answers become text answers, renormalised, with neutral defaults", () => {
    const a = fromJev({ continues: { value: 0.9 }, replyTo: { value: "L2", probabilities: { L1: 0.2, L2: 0.6, none: 0.2 } } }, 2);

    expect(a.continues).toBe(0.9);
    expect(a.newTopic).toBe(0.5);
    expect(a.replyTo).toEqual([0.2, 0.6, 0.2]);
    expect(fromJev({}, 0).replyTo).toEqual([1]);
  });
});

describe("decisions", () => {
  test("two voices taking turns become two speakers in one conversation", () => {
    const h = Array.from({ length: 10 }, (_, i) => line(i, i % 2, 0));
    const s = decide(h, freeAnswers(h));

    expect(counts(s)).toEqual({ speakers: 2, conversations: 1, topics: 1 });
    expect(s.lines.map((l) => l.who)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  });

  test("every decision's options sum to one, and switched-off signals push nothing", () => {
    const h = Array.from({ length: 6 }, (_, i) => line(i, i % 3, i < 3 ? 0 : 4));
    const off = { ...ALL_ON, voice: 0, topic: 0 };
    const s = decide(h, freeAnswers(h), off);

    for (const l of s.lines) {
      for (const d of [l.speaker, l.conversation]) {
        expect(d.options.reduce((a, o) => a + o.p, 0)).toBeCloseTo(1, 6);

        for (const o of d.options) {
          expect(Math.abs(o.push.voice ?? 0)).toBe(0);
          expect(Math.abs(o.push.topic ?? 0)).toBe(0);
        }
      }
    }
  });

  test("with a phone per table, lines on each phone form their own conversation", () => {
    const h = Array.from({ length: 12 }, (_, i) => line(i, i % 4, i % 2 ? 1 : 2, { channel: i % 2, balance: 8 }));
    const s = decide(h, freeAnswers(h));
    const conv = (c: number) => new Set(s.lines.filter((_, i) => i % 2 === c).map((l) => l.conv));

    expect(counts(s).conversations).toBe(2);
    expect(conv(0).size).toBe(1);
    expect(conv(1).size).toBe(1);
    expect([...conv(0)][0]).not.toBe([...conv(1)][0]);
  });

  test("sampled count odds are a distribution, and the same seed gives the same odds", () => {
    const h = Array.from({ length: 8 }, (_, i) => line(i, i % 2, 0));
    const t = freeAnswers(h);
    const a = countOdds(h, t, ALL_ON, h.length, 30);

    for (const m of Object.values(a)) expect([...m.values()].reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);

    expect([...countOdds(h, t, ALL_ON, h.length, 30).speakers]).toEqual([...a.speakers]);
  });

  test("hindsight gives every line a speaker that ended up real", () => {
    const h = Array.from({ length: 8 }, (_, i) => line(i, i % 2, 0));
    const s = decide(h, freeAnswers(h));
    const late = hindsight(s, h, ALL_ON);
    const real = new Set(s.speakers.filter((sp) => sp.n >= 2).map((sp) => sp.id));

    expect(late.every((l) => real.has(l.who))).toBe(true);
  });

  test("the text answers matter: a reply to the other group's line pulls the conversation over", () => {
    const h = [line(0, 0, 0), line(1, 1, 0), line(2, 0, 0), line(3, 2, 5), line(4, 3, 5), line(5, 2, 5), line(6, 4, 6)];
    const t: TextAnswers[] = freeAnswers(h);
    const hard = [...t];

    hard[6] = { continues: 0.1, replyTo: [0, 0, 0, 0, 1, 0, 0], newTopic: 0.1 };

    const s = decide(h, hard);
    const reply = s.lines[6].conversation.options.find((o) => o.id === s.lines[4].conv)!;

    expect(reply.push.reply).toBeGreaterThan(0);
    expect(SIGNALS).toContain("reply");
  });
});

describe("scoring", () => {
  const words = (spec: [number, string, string, number?][]) =>
    spec.map(([start, speaker, conversation, channel]) => ({ text: "w", start, end: start + 0.3, speaker, conversation, topic: "t", ...(channel === undefined ? {} : { channel }) }));

  test("a word goes to the segment covering most of it, on its own phone", () => {
    const h = [line(0, 0, 0, { start: 0, end: 1, channel: 0 }), line(1, 1, 0, { start: 0.5, end: 2, channel: 1 })];

    expect(attribute(words([[0.6, "a", "x", 0], [0.6, "b", "y", 1], [5, "c", "x", 0]]), h)).toEqual([0, 1, -1]);
  });

  test("labels match one to one, and missed words count as wrong", () => {
    expect(Object.fromEntries(match([0, 0, 1, 1, 1], ["a", "a", "a", "b", "b"]))).toEqual({ 0: "a", 1: "b" });
    expect(accuracy([0, 0, -1, 1], ["a", "a", "a", "b"]).share).toBe(0.75);
  });

  test("score counts words up to the last decided line", () => {
    const h = [line(0, 0, 0), line(1, 1, 0)];
    const truth: Truth = { words: words([[0.2, "a", "x"], [2.2, "b", "x"]]), counts: { speakers: 2, conversations: 1, topics: 1 } };
    const r = score(truth, h, [{ who: 0, conv: 0, topic: 0 }], 1);

    expect(r.words).toBe(1);
    expect(r.speaker.share).toBe(1);
  });
});

describe("signals", () => {
  test("long stretches are cut to at most five seconds", () => {
    const db = Array.from({ length: 1300 }, (_, f) => (f % 300 === 150 ? -60 : -20));

    for (const s of splitLong([{ start: 0, end: 12.5 }], db)) expect(s.end - s.start).toBeLessThanOrEqual(5);
  });

  test("with two phones, each hears only its own table's speech", async () => {
    const n = 16000 * 6;
    const tone = (a: number, b: number, f: number) => {
      const x = new Float32Array(n);

      for (let i = 0; i < n; i++) {
        const t = i / 16000;

        x[i] = 0.0005 * Math.sin(i * 12.9898) + (t >= a && t < b ? 0.3 * Math.sin(2 * Math.PI * f * t) : 0);
      }

      return x;
    };
    const near = [tone(0.5, 2, 220), tone(3.5, 5, 330)];
    const bleed = 10 ** (-12 / 20);
    const channels = near.map((x, c) => x.map((v, i) => v + bleed * near[1 - c][i]));
    const models: Models = {
      transcribe: async () => "hello there",
      embed: async (texts) => texts.map(() => [1, 0]),
      speaker: async () => new Float32Array([1, 0, 0]),
    };
    const heard = await listen(channels, models);

    expect(heard.map((h) => h.channel)).toEqual([0, 1]);
    expect(heard[0].start).toBeLessThan(1);
    expect(heard[1].start).toBeGreaterThan(3);
    expect(heard.every((h) => (h.balance ?? 0) > 6)).toBe(true);
  });

  test("a table's quiet line under louder talk at the other table is kept", async () => {
    const n = 16000 * 6;
    const tone = (a: number, b: number, f: number, amp: number) => {
      const x = new Float32Array(n);

      for (let i = 0; i < n; i++) {
        const t = i / 16000;

        x[i] = 0.0005 * Math.sin(i * 12.9898) + (t >= a && t < b ? amp * Math.sin(2 * Math.PI * f * t) : 0);
      }

      return x;
    };
    // Table 2 talks for 5 s; table 1 says one quieter line (about 9.5 dB down) in the middle of it.
    const near = [tone(2, 3, 220, 0.1), tone(0.5, 5.5, 330, 0.3)];
    const bleed = 10 ** (-12 / 20);
    const channels = near.map((x, c) => x.map((v, i) => v + bleed * near[1 - c][i]));
    const models: Models = {
      transcribe: async () => "hello there",
      embed: async (texts) => texts.map(() => [1, 0]),
      speaker: async () => new Float32Array([1, 0, 0]),
    };
    const heard = await listen(channels, models);
    const own = heard.filter((h) => h.channel === 0);

    expect(own.length).toBe(1);
    expect(own[0].start).toBeGreaterThan(1.8);
    expect(own[0].end).toBeLessThan(3.2);
    expect(own[0].balance!).toBeLessThan(0);
    expect(heard.filter((h) => h.channel === 1).length).toBeGreaterThan(0);
  });
});

describe("transcript", () => {
  test("labels are renumbered by first appearance and grouped by conversation", () => {
    const h = [line(0, 0, 0), line(1, 1, 0), line(2, 0, 0)];

    expect([...renumber([5, 2, 5])]).toEqual([
      [5, 0],
      [2, 1],
    ]);
    expect(markdown(h, [{ who: 4, conv: 3 }, { who: 4, conv: 1 }, { who: 7, conv: 3 }])).toBe(
      "## Conversation A\n\n**Speaker 1** (0:00): line 0 and so on\n\n**Speaker 2** (0:04): line 2 and so on\n\n## Conversation B\n\n**Speaker 1** (0:02): line 1 and so on",
    );
  });
});
