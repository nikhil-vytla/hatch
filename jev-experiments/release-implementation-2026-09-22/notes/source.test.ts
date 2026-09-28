import { expect, test } from "bun:test";
import {
  sourceExcerpt,
  sourceSha256,
} from "../../experience-prototypes/src/components/source-code/source";

test("every displayed mechanism is extracted from its maintained source", async () => {
  const cases = [
    [
      "roadmap/runtime/contract.ts",
      "export function decisionSummary(",
      "/** Returns explicit issues",
    ],
    [
      "live-worlds/crowd/engine.ts",
      "export function ticketCurrent(",
      "export type Reply",
    ],
    [
      "roadmap/routing/policy.ts",
      "export function qualityForTask(",
      "// UTF-8 bytes",
    ],
    [
      "experience-prototypes/src/notes/score-mechanism.ts",
      "export function summarizeScore(",
      undefined,
    ],
  ] as const;
  for (const [path, start, end] of cases) {
    const source = await Bun.file(
      new URL(`../../${path}`, import.meta.url),
    ).text();
    const excerpt = sourceExcerpt({ text: source, path }, { start, end });
    expect(excerpt).not.toBeNull();
    expect(source.split("\n")[excerpt!.startLine - 1].startsWith(start)).toBe(
      true,
    );
    expect(source).toContain(excerpt!.text);
  }
});

test("source drift returns an explicit unavailable excerpt", () => {
  expect(
    sourceExcerpt(
      { text: "function next() {}", path: "fixture.ts" },
      { start: "function prior()", end: "}" },
    ),
  ).toBeNull();
  expect(
    sourceExcerpt(
      { text: "function next() {}", path: "fixture.ts" },
      { start: "function next()", end: "// absent" },
    ),
  ).toBeNull();
});

test("the fingerprint describes the exact downloaded file bytes", async () => {
  expect(await sourceSha256({ text: "abc", path: "fixture.ts" })).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(await sourceSha256({ text: "abc\n", path: "fixture.ts" })).not.toBe(
    await sourceSha256({ text: "abc", path: "fixture.ts" }),
  );
});
