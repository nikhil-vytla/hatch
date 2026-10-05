/**
 * TypeSafe's list price for Jev, in one place. Input tokens are billed, output is free.
 * Source: https://docs.typesafe.ai/models, read 29 Sep 2026. Change it here when it changes
 * (and in src/jev_lab/core.py, the Python ledger's own copy).
 */
export const JEV_PRICE = {
  usdPerMillionInputTokens: 0.042,
  readOn: "29 Sep 2026",
  source: "https://docs.typesafe.ai/models",
} as const;

export const JEV_USD_PER_INPUT_TOKEN = JEV_PRICE.usdPerMillionInputTokens / 1e6;

/** The list-price cost of a request with this many input tokens. */
export const jevCostUsd = (inputTokens: number) => (inputTokens * JEV_PRICE.usdPerMillionInputTokens) / 1e6;

/** "$0.042 per million input tokens, output free", for copy. */
export const JEV_PRICE_TEXT = `$${JEV_PRICE.usdPerMillionInputTokens} per million input tokens, output free`;
