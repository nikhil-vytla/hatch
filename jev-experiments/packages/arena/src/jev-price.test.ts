import { describe, expect, test } from "bun:test";
import { JEV_PRICE, JEV_PRICE_TEXT, JEV_USD_PER_INPUT_TOKEN, jevCostUsd } from "../../jev-client/src/price";

describe("Jev's list price", () => {
  test("is TypeSafe's published rate", () => {
    expect(JEV_PRICE.usdPerMillionInputTokens).toBe(0.042);
    expect(JEV_PRICE.readOn).toBe("29 Sep 2026");
  });

  test("keeps the arithmetic each call site used before it was shared", () => {
    // Divide-first sites used 0.042 / 1e6; multiply-first sites used (tokens * 0.042) / 1e6.
    expect(JEV_USD_PER_INPUT_TOKEN).toBe(0.042 / 1e6);

    for (const t of [0, 1, 355, 2000, 26408, 1_000_000]) expect(jevCostUsd(t)).toBe((t * 0.042) / 1e6);
  });

  test("reads the same in copy as before", () => {
    expect(JEV_PRICE_TEXT).toBe("$0.042 per million input tokens, output free");
  });
});
