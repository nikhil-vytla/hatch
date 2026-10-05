import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { manifest } from "./publication-manifest";
import { context, gzipHeaderSource, gzippedRecordings, ownerOf, publishedDocument, unlistedFiles, type Entry } from "./publication";
import { decodeRecord, encodeRecord, readRecord, recordExists } from "./records";
import { gzipRules } from "./gzip-published";
import { assertPreserved } from "../../roadmap/verification/record-integrity";
import { retired, scenes } from "../src/scenes";
import vercel from "../vercel.json";

const ctx = context();
const records = manifest.filter((e) => e.record && !e.record.build);
const built = manifest.filter((e) => e.record?.build);
const paths = manifest.filter((e) => e.path);

describe("each published record", () => {
  test.each(records.map((e) => [e.id, e] as const))("%s keeps every recorded value", (_, entry: Entry) => {
    const source = resolve(ctx.app, entry.record!.source);
    expect(recordExists(source)).toBe(true);
    const original = readRecord(source);
    // jev-records-v1 round trip.
    expect(decodeRecord(encodeRecord(original))).toEqual(original);
    // The published document only adds fields to the source, or to its projection when it has one.
    const published = publishedDocument(entry, ctx);
    const expected = entry.record!.projection ? entry.record!.projection.project(original) : original;
    expect(() => assertPreserved(expected, published, entry.id)).not.toThrow();
  });

  test.each(built.map((e) => [e.id, e] as const))("%s builds a document that keeps its committed record", (_, entry: Entry) => {
    const out = mkdtempSync(join(tmpdir(), "publication-"));
    const document = publishedDocument(entry, { ...ctx, out: (path) => join(out, path) });
    expect(() => assertPreserved(readRecord(resolve(ctx.app, entry.record!.source)), document, entry.id)).not.toThrow();
  });
});

describe("each published path", () => {
  test.each(paths.map((e) => [e.id, e] as const))("%s has its inputs and owns its files", (_, entry: Entry) => {
    expect(entry.committed || entry.write || entry.copy || entry.record?.build).toBeTruthy();
    if (entry.committed) expect(existsSync(ctx.out(entry.path!))).toBe(true);
    for (const item of entry.copy ?? [])
      expect(item.record ? recordExists(resolve(ctx.app, item.from)) : existsSync(resolve(ctx.app, item.from))).toBe(true);
    expect(ownerOf(`${entry.path}/x.json`) ?? ownerOf(entry.path!)).toBe(entry);
    for (const file of entry.volatile ?? []) expect(ownerOf(file)).toBe(entry);
  });
});

describe("the manifest", () => {
  test("ids and paths are unique", () => {
    const ids = manifest.map((e) => e.id),
      owned = paths.map((e) => e.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(owned).size).toBe(owned.length);
  });

  test("publishes every record a scene or a retired scene's notice offers", () => {
    const published = new Set(manifest.filter((e) => e.record).map((e) => e.id));
    const wanted = [
      ...scenes.flatMap((s) => [s.record, s.companion]),
      ...Object.values(retired).map((r) => r.record),
    ].filter((r): r is string => !!r);
    expect(wanted.filter((r) => !published.has(r))).toEqual([]);
  });

  test("refuses public files no entry owns", () => {
    const root = mkdtempSync(join(tmpdir(), "public-"));
    for (const file of ["data/paste.json", "arena/index.json", "research/quality-review/review.html", "data/language.json", "stray.txt", "research/notes.txt"]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "{}");
    }
    expect(unlistedFiles(root)).toEqual(["data/language.json", "stray.txt"]);
    // research/ owns its copies; a file beside them is the research entry's, not unlisted.
    expect(ownerOf("research/notes.txt")?.id).toBe("research");
    expect(ownerOf("research/quality-review/review.html")?.id).toBe("quality-review");
  });

  test("vercel.json serves exactly the gzip paths gzip-encoded", () => {
    const rules = vercel.headers.filter((h) => h.headers.some((x) => x.key === "Content-Encoding"));
    expect(rules.map((r) => r.source)).toEqual([gzipHeaderSource()]);
    const hit = (url: string) => gzipRules(JSON.stringify(vercel)).some((r) => r.test(url));
    for (const entry of manifest) {
      if (entry.record) expect(hit(`/data/${entry.id}.json`)).toBe(true);
      if (entry.path) expect([entry.id, hit(`/${entry.path}/x.json`)]).toEqual([entry.id, !!entry.gzip]);
    }
  });

  test("every recording kept gzipped has its working copy ignored", () => {
    const list = gzippedRecordings();
    expect(list.length).toBeGreaterThan(0);
    const ignored = spawnSync("git", ["check-ignore", ...list], { cwd: ctx.lab, encoding: "utf8" }).stdout.trim().split("\n");
    expect(ignored).toEqual(list);
  });
});
