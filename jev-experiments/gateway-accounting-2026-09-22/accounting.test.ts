import { expect, test } from "bun:test";
import { accountingIssue, parseCost, requestAccounting, usageIssue, type RequestAttempt } from "../roadmap/runtime/accounting";

const attempt = (n = 1): RequestAttempt => ({
  attempt: n, status: 200, requestMs: 2, requestedModel: "typesafe-ai/jev",
  model: "authored-fixture", modelSource: "provider-reported", usage: { inputTokens: 2 },
  costUsd: 0.001, accountingScope: "gateway-response", providerAttempts: "unknown", issues: [],
});

test("cost observations never use JavaScript coercions", () => {
  for (const value of [undefined, null, "", " ", true, false, [], {}, NaN, Infinity, -1, "-1", "0x10"])
    expect(parseCost(value)).toBeNull();
  for (const value of [0, "0", "0.0", "0e3"]) expect(parseCost(value)).toBe(0);
  expect(parseCost("0.001")).toBe(0.001);
});

test("token observations are nonnegative safe integers with coherent totals", () => {
  for (const value of [{}, { inputTokens: 1.5 }, { inputTokens: -1 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { inputTokens: 2, outputTokens: 1, totalTokens: 4 }, { tokens: 2 }]) expect(usageIssue(value)).not.toBeNull();
  for (const value of [{ inputTokens: 0 }, { totalTokens: 1 }, { inputTokens: 2, outputTokens: 1, totalTokens: 3 }])
    expect(usageIssue(value)).toBeNull();
});

test("accounting snapshots are independent and reject invented totals", () => {
  const attempts = [attempt(), { ...attempt(2), costUsd: null, usage: null }];
  const snapshot = requestAccounting(attempts);
  attempts[0].issues.push("later");
  expect(snapshot.attempts[0].issues).toEqual([]);
  expect(snapshot.costUsd).toBeNull(); expect(snapshot.usage).toBeNull();
  expect(accountingIssue(snapshot)).toBeNull();
  expect(accountingIssue({ ...snapshot, costUsd: 0.001 })).not.toBeNull();
  expect(accountingIssue({ ...snapshot, usage: { inputTokens: 2 } })).not.toBeNull();
  const pending = requestAccounting([{ ...attempt(), status: "pending" }]);
  expect(accountingIssue(pending)).not.toBeNull();
});

test("overflowed sums are unknown while independent fields survive", () => {
  const many = [attempt(), attempt(2)].map(a => ({ ...a, costUsd: Number.MAX_VALUE,
    usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 } }));
  const result = requestAccounting(many);
  expect(result.costUsd).toBeNull(); expect(result.usage).toEqual({ outputTokens: 2 });
  expect(accountingIssue(result)).toBeNull();
  expect(requestAccounting([])).toMatchObject({ attempts: [], costUsd: 0, usage: null });
});
