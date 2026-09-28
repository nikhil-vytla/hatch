import { describe, expect, test } from "bun:test";
import { runEntry } from "./one-box";
import { sandboxEntry } from "./sandbox";
import { scoreSealed, seal, unseal, type Sealed } from "./sealed";

const phrases = [
  { id: "a", text: "remind me to call mom", intent: "reminder", kind: "plain" as const },
  { id: "b", text: "dinner with sam fri 7pm", intent: "event", kind: "plain" as const },
];

const rule = `export function answer(state) {
  return { intent: state.text.includes("remind") ? { reminder: 9, note: 1 } : { event: 3, note: 1 } };
}`;

describe("sandbox", () => {
  test("runs an exported answer() and scores it like any entry", async () => {
    const { entry, dispose } = await sandboxEntry(rule);
    const run = runEntry(entry, phrases, "cancel");

    dispose();
    expect(run.errors).toBe(0);
    expect(run.phrases.map((p) => p.outcome.finalRight)).toEqual([true, true]);
  });

  test("has no network and stops an endless loop", async () => {
    const { entry, dispose } = await sandboxEntry(
      `export function answer(s) { if (s.text.length > 3) { while (true) {} } return { x: typeof fetch }; }`,
    );

    const run = runEntry(entry, phrases, "cancel");

    dispose();
    expect(run.errors).toBeGreaterThan(0);
    expect(run.firstError).toContain("interrupted");
  });

  test("code that doesn't load says why", async () => {
    await expect(sandboxEntry("export function answer( {")).rejects.toThrow("did not load");
  });
});

describe("sealed", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  const sealed: Sealed = {
    schema: "one-box.sealed/1",
    sealedAt: "2026-09-26",
    phrases,
    jev: {},
  };

  test("seals and unseals; a wrong key fails", () => {
    const blob = seal(sealed, key);

    expect(unseal(blob, key)).toEqual(sealed);
    expect(() => unseal(blob, Buffer.alloc(32, 8).toString("base64"))).toThrow();
  });

  test("scores an entry beside Jev's recorded answers, returning only aggregates", async () => {
    const { entry, dispose } = await sandboxEntry(rule);
    const score = scoreSealed(entry, sealed);

    dispose();
    expect(score.phrases).toBe(2);
    expect(score.boxRight).toBe(1);
    // No recorded Jev answers here, so Jev's box never shows a card.
    expect(score.jevBoxRight).toBe(0);
    expect(score.gainOverJev.mean).toBeGreaterThan(0);
  });
});
