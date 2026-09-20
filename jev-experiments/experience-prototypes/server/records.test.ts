import { test, expect } from "bun:test";
import { encodeRecord, decodeRecord } from "../scripts/records";
import { spawnSync } from "node:child_process";
const document = JSON.parse(
  '{"meta":{"empty":[],"unicode":"こんにちは\u2028line\u2029paragraph","nested":{"items":[null,{"list":[1,2]}]}},"rows":[{"answer":"A","probabilities":{"A":0.9,"B":0.1}}],"__proto__":{"items":["literal data"]}}',
);
test("JSONL preserves nested records and literal object keys across Python and TypeScript", () => {
  const encoded = encodeRecord(document);
  expect(decodeRecord(encoded)).toEqual(document);
  const python = spawnSync(
    "../.venv/bin/python",
    [
      "-c",
      "import sys;sys.path.insert(0,'../src');from jev_lab.records import decode_record,encode_record;print(encode_record(decode_record(sys.stdin.read())),end='')",
    ],
    { input: encoded, encoding: "utf8" },
  );
  expect(python.status).toBe(0);
  expect(decodeRecord(python.stdout)).toEqual(document);
  for (const value of [null, 4, "text", [], [1, { a: [] }], {}])
    expect(decodeRecord(encodeRecord(value))).toEqual(value);
  expect(({} as any).items).toBeUndefined();
});
test("JSONL rejects reordered, duplicated, missing, and inherited paths", () => {
  const header = JSON.stringify({
    format: "jev-records-v1",
    document: { rows: [] },
  });
  for (const entry of [
    { path: ["rows"], index: 1, value: 1 },
    { path: ["missing"], index: 0, value: 1 },
    { path: ["__proto__", "rows"], index: 0, value: 1 },
    { path: ["rows"], index: 0 },
  ])
    expect(() => decodeRecord(header + "\n" + JSON.stringify(entry))).toThrow();
  const line = JSON.stringify({ path: ["rows"], index: 0, value: 1 });
  expect(() => decodeRecord(header + "\n" + line + "\n" + line)).toThrow();
});
