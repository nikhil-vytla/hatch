/** `eval` end to end against the local mock: recording, resume, budget cap, fail-fast, dry run. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decoy } from "../src/analysis";
import { compare } from "../src/compare";
import { endpoint } from "../src/endpoints";
import { serveMock } from "../src/mock";
import { readRows, receipt, run } from "../src/record";
import { jobsFor } from "../src/studies";

const dir = mkdtempSync(join(tmpdir(), "jev-lab-"));
const ok = serveMock();
const down = serveMock({ failWith: 503 });

afterAll(() => {
  ok.stop(true);
  down.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const quiet = () => {};

describe("eval against the mock /v1/systemone", () => {
  const out = join(dir, "decoy.jsonl");
  const ep = endpoint(`systemone:http://localhost:${ok.port}`);

  test("records every request in our row shape, and the analysis reads it", async () => {
    const r = await run(jobsFor("decoy"), ep, { out, log: quiet });
    const rows = readRows(out);

    expect(r.ok).toBe(48);
    expect(rows).toHaveLength(48);
    expect(rows[0]).toMatchObject({ status: "ok", endpoint: ep.label });
    expect(rows[0]!.answers!.q!.probabilities).not.toBeNull();
    expect(decoy(rows).scenarios).toHaveLength(8);
    expect(receipt(rows).ok).toBe(48);
  });

  test("resume skips what is already recorded", async () => {
    const r = await run(jobsFor("decoy"), ep, { out, resume: true, log: quiet });

    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(48);
  });

  test("compare lines a fresh run up against our recording", () => {
    const ours = readRows(new URL("../../../packages/arena/prose/recordings/prose.jsonl.gz", import.meta.url).pathname);
    const c = compare(ours, readRows(out));

    expect(c.studies).toEqual(["decoy"]);
    expect(c.agreement.shared).toBe(48);
    expect(c.perStudy[0]).toHaveProperty("difference");
  });

  test("--max-usd stops before a request could break the cap", async () => {
    const priced = endpoint(`systemone:http://localhost:${ok.port}`, { usdPerMTok: 10 });
    const r = await run(jobsFor("fool"), priced, { out: join(dir, "capped.jsonl"), maxUsd: 0.01, log: quiet });

    expect(r.stopped).toContain("budget");
    expect(r.spentUsd).toBeLessThanOrEqual(0.01);
    expect(r.ok).toBeGreaterThan(0);
  });

  test("a dead server stops the run after five failures in a row, all logged as errors", async () => {
    const outDown = join(dir, "down.jsonl");
    const r = await run(jobsFor("decoy"), endpoint(`systemone:http://localhost:${down.port}`), { out: outDown, log: quiet, wait: async () => {} });
    const rows = readRows(outDown);

    expect(r.stopped).toContain("5 failures in a row");
    expect(rows.every((x) => x.status === "error")).toBe(true);
    expect(rows).toHaveLength(5);
  });

  test("--dry-run sends and writes nothing", async () => {
    const lines: string[] = [];
    const outDry = join(dir, "dry.jsonl");
    const r = await run(jobsFor("suggestion"), endpoint("jev"), { out: outDry, dryRun: true, log: (l) => lines.push(l) });

    expect(r.sent).toBe(0);
    expect(existsSync(outDry)).toBe(false);
    expect(lines).toHaveLength(101);
    expect(lines.at(-1)).toContain("Nothing was sent");
  });
});
