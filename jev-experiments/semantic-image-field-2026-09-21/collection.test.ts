import { describe, expect, test } from "bun:test";
import {
  createCollection,
  MAX_COLLECTION,
  parseCollection,
  type CollectionItem,
} from "./collection";

const HASH = "a".repeat(64);
const works = Array.from({ length: MAX_COLLECTION + 1 }, (_, i) => ({
  id: i + 1,
  title: `Artwork ${i + 1}`,
  artist: "An artist",
  sourceUrl: `https://example.test/artworks/${i + 1}`,
  caption: "Museum description",
  imageUrl: `https://example.test/images/${i + 1}.jpg`,
  imageMirror: {
    artwork_id: i + 1,
    image_url: `https://example.test/mirrors/${i + 1}.jpg`,
    commons_page: `https://example.test/sources/${i + 1}`,
    license: "Public domain",
    matched_by: "Artwork ID",
    match_source: `https://example.test/artworks/${i + 1}`,
  },
}));
const item = (artworkId = 1): CollectionItem => ({
  artworkId,
  query: "A quiet blue evening",
  method: "caption",
  score: 3.5,
  rank: 1,
  evidence: "recorded",
});
const saved = (items: unknown = [item()]) => ({
  version: "jev-artwork-collection-v1",
  collection_sha256: HASH,
  items,
});

test("round-trip retains order, zero scores, explicit unavailable values and query text", () => {
  const items = [
    {
      ...item(2),
      query: "",
      score: null,
      rank: null,
      evidence: "live exploratory" as const,
    },
    { ...item(1), score: 0 },
    {
      ...item(3),
      method: "lexical" as const,
      score: 15,
      evidence: "deterministic lexical" as const,
    },
  ];
  const artifact = createCollection(items, works, HASH);
  expect(
    parseCollection(JSON.parse(JSON.stringify(artifact)), works, HASH),
  ).toEqual(items);
  expect(artifact.items[0].score).toBeNull();
  expect(artifact.items[0].rank).toBeNull();
  expect(artifact.items[1].score).toBe(0);
});

test("unrun model queries round-trip explicitly without scores or ranks", () => {
  const items: CollectionItem[] = ["caption", "metadata"].map(
    (method, index) => ({
      ...item(index + 1),
      method: method as "caption" | "metadata",
      score: null,
      rank: null,
      evidence: "not run",
    }),
  );
  const artifact = createCollection(items, works, HASH);
  expect(
    parseCollection(JSON.parse(JSON.stringify(artifact)), works, HASH),
  ).toEqual(items);
  expect(artifact.items.map((value) => value.evidence)).toEqual([
    "not run",
    "not run",
  ]);
});

test("partial recorded and live runs retain explicit unavailable results", () => {
  const items: CollectionItem[] = [
    { ...item(1), score: null, rank: null, evidence: "recorded" },
    { ...item(2), score: null, rank: null, evidence: "live exploratory" },
  ];
  expect(
    parseCollection(createCollection(items, works, HASH), works, HASH),
  ).toEqual(items);
});

test("evidence matches the ranking method and unavailable values stay paired", () => {
  const invalid: CollectionItem[] = [
    { ...item(), evidence: "deterministic lexical" },
    ...(["recorded", "live exploratory", "not run"] as const).map(
      (evidence) => ({
        ...item(),
        method: "lexical" as const,
        evidence,
      }),
    ),
    { ...item(), evidence: "not run" },
    { ...item(), score: null },
    { ...item(), rank: null },
  ];
  for (const value of invalid) {
    expect(() => parseCollection(saved([value]), works, HASH)).toThrow();
    expect(() => createCollection([value], works, HASH)).toThrow();
  }
});

test("imported and unknown metadata cannot replace the authored artwork or escape into export", () => {
  const imported = {
    ...saved([
      {
        ...item(),
        artwork: { title: "Forged", sourceUrl: "javascript:forged" },
        extra: "ignored",
      },
    ]),
    unknown: "ignored",
  };
  const parsed = parseCollection(imported, works, HASH);
  expect(parsed).toEqual([item()]);
  const output = createCollection(parsed, works, HASH);
  expect(output.items[0].artwork).toEqual(works[0]);
  expect(output.items[0]).not.toHaveProperty("extra");
  expect(output).not.toHaveProperty("unknown");
  expect(output.items[0].artwork).not.toBe(works[0]);
  expect(output.items[0].artwork.imageMirror).not.toBe(works[0].imageMirror);
  output.items[0].artwork.imageMirror!.license = "Changed export";
  expect(works[0].imageMirror.license).toBe("Public domain");
});

test("export also ignores metadata smuggled into a typed item", () => {
  const untrusted = {
    ...item(),
    artwork: { title: "Forged" },
    arbitrary: BigInt(1),
  };
  const artifact = createCollection([untrusted], works);
  expect(artifact.collection_sha256).toBeNull();
  expect(artifact.items[0].artwork.title).toBe(works[0].title);
  expect(() => JSON.stringify(artifact)).not.toThrow();
});

test("empty and twelve-item collections are valid; a thirteenth and duplicates are rejected", () => {
  expect(parseCollection(createCollection([], works), works, HASH)).toEqual([]);
  expect(
    parseCollection(
      saved(works.slice(0, MAX_COLLECTION).map((w) => item(w.id))),
      works,
    ),
  ).toHaveLength(12);
  expect(() =>
    parseCollection(saved(works.map((w) => item(w.id))), works),
  ).toThrow("at most 12");
  expect(() => createCollection([item(), item()], works)).toThrow(
    "more than once",
  );
});

test("unknown current-collection IDs and explicit hash mismatches are rejected", () => {
  expect(() => parseCollection(saved([item(999)]), works)).toThrow(
    "not in the current collection",
  );
  expect(() => parseCollection(saved(), works, "b".repeat(64))).toThrow(
    "different artwork collection",
  );
  expect(
    parseCollection({ ...saved(), collection_sha256: null }, works, HASH),
  ).toEqual([item()]);
  expect(parseCollection(saved(), works)).toEqual([item()]);
});

describe("malformed collection headers", () => {
  for (const value of [
    null,
    [],
    {},
    "collection",
    { ...saved(), version: "v2" },
    { ...saved(), collection_sha256: 3 },
    { ...saved(), collection_sha256: undefined },
    { ...saved(), items: null },
    { ...saved(), items: {} },
  ]) {
    test(JSON.stringify(value), () =>
      expect(() => parseCollection(value, works)).toThrow(),
    );
  }
});

describe("malformed collection items", () => {
  const invalid: unknown[] = [
    null,
    [],
    { ...item(), artworkId: "1" },
    { ...item(), artworkId: 1.5 },
    { ...item(), query: 7 },
    { ...item(), query: "x".repeat(801) },
    { ...item(), method: "vision" },
    { ...item(), score: NaN },
    { ...item(), score: Infinity },
    { ...item(), score: true },
    { ...item(), score: undefined },
    { ...item(), rank: 0 },
    { ...item(), rank: -1 },
    { ...item(), rank: 1.5 },
    { ...item(), rank: Infinity },
    { ...item(), rank: undefined },
    { ...item(), evidence: "verified" },
  ];
  invalid.forEach((value, index) => {
    test(`case ${index + 1}`, () =>
      expect(() => parseCollection(saved([value]), works)).toThrow());
  });
});

test("800-character queries and finite fractional scores survive without coercion", () => {
  const input = {
    ...item(),
    query: "x".repeat(800),
    score: 0.125,
    method: "metadata" as const,
  };
  expect(parseCollection(saved([input]), works, HASH)).toEqual([input]);
});

test("sparse item arrays cannot export missing entries as null", () => {
  const sparse: CollectionItem[] = new Array(1);
  expect(() => createCollection(sparse, works)).toThrow("must be an object");
});
