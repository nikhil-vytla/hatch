import { expect, test } from "bun:test";
import type { Event } from "@strive/protocol";
import { Spend } from "./spend";

const started = (call: number, usd: number): Event => ({
  type: "modelCallStarted",
  call,
  provider: "anthropic",
  model: "claude-haiku-4-5",
  request: "sha256:00",
  reservedUsdMicros: usd,
  reservedTokens: 10,
});

test("spend follows the ledger's rules for each outcome", () => {
  const s = new Spend();
  for (const e of [
    { type: "budgetSet", usdMicros: 5_000_000 },
    started(1, 900),
    { type: "modelCallFinished", call: 1, durationMs: 1, outcome: { kind: "complete", status: 200, usage: { input: 1, output: 1, cacheWrite: 0, cacheWriteLong: 0, cacheRead: 0 }, costUsdMicros: 350 } },
    started(2, 900),
    { type: "modelCallFinished", call: 2, durationMs: 1, outcome: { kind: "rejected", status: 429 } },
    started(3, 900),
    { type: "modelCallFinished", call: 3, durationMs: 1, outcome: { kind: "broken", reason: "cut", costUsdMicros: 900, tokens: 10 } },
    started(4, 700),
  ] as Event[])
    s.apply(e);
  expect(s.summary()).toBe("$0.0013 of $5.0000 · holding $0.0007");
});

test("an unlimited budget and no spend read plainly", () => {
  const s = new Spend();
  s.apply({ type: "budgetSet" });
  expect(s.summary()).toBe("$0.0000 spent · no budget");
});

test("a changed budget replaces the old one", () => {
  const s = new Spend();
  s.apply({ type: "budgetSet", usdMicros: 5_000_000 });
  s.apply({ type: "budgetSet", usdMicros: 250_000, tokens: 1000 });
  expect(s.summary()).toBe("$0.0000 of $0.2500 · 0 of 1000 tokens");
});
