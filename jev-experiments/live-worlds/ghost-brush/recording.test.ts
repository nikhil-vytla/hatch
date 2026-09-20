import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import examples from "./examples.json";
import { RECIPES } from "./engine";
import { parseRanking, requestFor } from "./model";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
test("both authored recordings use the exact UI contract and preserve every judgment", () => {
  expect(examples.rows).toHaveLength(2); expect(examples.bankSha256).toBe(hash(RECIPES));
  for (const row of examples.rows) {
    expect(row.request).toEqual(requestFor(row.prompt)); expect(row.requestSha256).toBe(hash(row.request));
    expect(row.responseSha256).toBe(hash(row.response)); expect(row.ranking).toEqual(parseRanking(row.response));
    expect(Object.keys(row.response.answers)).toHaveLength(10); expect(row.response.attempts.every(a => a.status === 200)).toBe(true);
  }
});
