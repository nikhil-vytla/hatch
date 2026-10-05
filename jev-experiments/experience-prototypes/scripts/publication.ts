/**
 * The build-to-public seam. Reads the publication manifest, writes public/, and builds the
 * integrity index CI holds fixed. One reader of the manifest, so the build, the gzip rule, the
 * recordings kept compressed and the verification cannot drift apart.
 *
 *   publish()              write every entry into public/, then refuse files no entry owns
 *   publishedDocument(e)   one record as it is published, from its source
 *   integrityIndex()       check public/ and vercel.json against the manifest; describe all of public/
 *   gzipHeaderSource()     the vercel.json header rule for the `gzip` paths
 *   gzippedRecordings()    the committed .gz recordings compress-records.ts refreshes
 */
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Step } from "./provenance";
import { copyRecord, decodeRecord, encodeRecord, readRecord, readRecordBytes, recordExists } from "./records";
import { manifest as defaultManifest, builderRecordings } from "./publication-manifest";
import { assertPreserved } from "../../roadmap/verification/record-integrity";

/** Paths an entry's functions get: the app root, jev-experiments/, and a resolver into public/. */
export type Context = { app: string; lab: string; out: (path: string) => string };

/** A display transform of the whole document, applied after the steps; verification applies it to the source too. */
export type Projection = {
  name: string;
  project<T>(document: T): T;
  /** Lineage for a derived source, recorded in the index. */
  derivation?(document: unknown): unknown;
};

export type RecordSpec = {
  /** The jev-records-v1 file, relative to the app (a committed `.gz` is read transparently). */
  source: string;
  /** Provenance added to `result`, in order. */
  steps?: readonly Step[];
  projection?: Projection;
  /** Builds the published document (and the entry's files) itself; its source is what it must preserve. */
  build?: { name: string; run(ctx: Context): unknown };
};

export type Copy = {
  /** Relative to the app. A directory is copied into `to`. */
  from: string;
  /** Relative to the entry's path. */
  to: string;
  /** A jev-records-v1 recording that may be stored as `.gz`: copy its decompressed bytes. */
  record?: true;
};

export type Entry = {
  id: string;
  /** Published at public/data/<id>.json. */
  record?: RecordSpec;
  /** The file or directory under public/ this entry owns. */
  path?: string;
  /** Committed to git under public/; nothing writes it. */
  committed?: true;
  /** Served with Content-Encoding: gzip (its .json and .jsonl files; see vercel.json). */
  gzip?: true;
  copy?: readonly Copy[];
  write?(ctx: Context): unknown;
  /** Files whose bytes change on every build (times); the index lists them without a hash. */
  volatile?: readonly string[];
};

const here = import.meta.dir;
export const appRoot = resolve(here, "..");

export function context(app = appRoot): Context {
  return { app, lab: resolve(app, ".."), out: (path) => resolve(app, "public", path) };
}

const recordPath = (entry: Entry) => `data/${entry.id}.json`;

/** One record as it is published: read, its steps, its projection. */
export function publishedDocument(entry: Entry, ctx = context()): any {
  const spec = entry.record!;
  if (spec.build) return spec.build.run(ctx);
  const source = resolve(ctx.app, spec.source);
  if (!recordExists(source)) throw new Error(`Missing recorded evidence: ${spec.source}`);
  const document = readRecord(source);
  if (document.result) for (const step of spec.steps ?? []) step.apply(document.result, ctx.lab);
  return spec.projection ? spec.projection.project(document) : document;
}

/** What the index says produced a record. */
export const recipe = (spec: RecordSpec) =>
  spec.build ? spec.build.name : ["readRecord", ...(spec.steps ?? []).map((s) => s.name), ...(spec.projection ? [spec.projection.name] : [])].join(" + ");

function copy(ctx: Context, entry: Entry, item: Copy) {
  const from = resolve(ctx.app, item.from),
    to = resolve(ctx.out(entry.path!), item.to);
  if (item.record ? !recordExists(from) : !existsSync(from)) throw new Error(`Missing publication input: ${item.from}`);
  if (!item.record && statSync(from).isDirectory()) return cpSync(from, to, { recursive: true });
  mkdirSync(dirname(to), { recursive: true });
  if (item.record) copyRecord(from, to);
  else copyFileSync(from, to);
}

/** Writes every entry into public/, in manifest order, then refuses files no entry owns. */
export async function publish(manifest: readonly Entry[] = defaultManifest, ctx = context()) {
  mkdirSync(ctx.out("data"), { recursive: true });
  for (const entry of manifest) {
    if (entry.record) writeFileSync(ctx.out(recordPath(entry)), JSON.stringify(publishedDocument(entry, ctx)) + "\n");
    if (entry.committed && !existsSync(ctx.out(entry.path!)))
      throw new Error(`Missing committed public file: public/${entry.path}`);
    await entry.write?.(ctx);
    for (const item of entry.copy ?? []) copy(ctx, entry, item);
  }
  const unlisted = unlistedFiles(ctx.out("."), manifest);
  if (unlisted.length)
    throw new Error(`Unlisted public files: ${unlisted.join(", ")}. Remove them or add them to scripts/publication-manifest.ts.`);
}

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .flatMap((name) => {
          const path = join(dir, name);
          return statSync(path).isDirectory() ? walk(path) : [path];
        })
    : [];

/** Every file under `root`, as a public path with forward slashes, sorted. */
export const publicFiles = (root: string) => walk(root).map((path) => relative(root, path).split(sep).join("/"));

const within = (file: string, path: string) => file === path || file.startsWith(`${path}/`);

/** The entry that owns a public file: its record, or the deepest path containing it. */
export function ownerOf(file: string, manifest: readonly Entry[] = defaultManifest): Entry | undefined {
  const record = manifest.find((e) => e.record && recordPath(e) === file);
  if (record) return record;
  return manifest
    .filter((e) => e.path && within(file, e.path))
    .sort((a, b) => b.path!.length - a.path!.length)[0];
}

/** Files under public/ that no entry owns. */
export const unlistedFiles = (root: string, manifest: readonly Entry[] = defaultManifest) =>
  publicFiles(root).filter((file) => !ownerOf(file, manifest));

/** The `source` of vercel.json's gzip header rule. */
export const gzipHeaderSource = (manifest: readonly Entry[] = defaultManifest) =>
  `/(${["data", ...manifest.filter((e) => e.gzip).map((e) => e.path!)].join("|")})/(.*)\\.(json|jsonl)`;

/** Recordings, relative to jev-experiments/, committed as `.gz` with a gitignored working copy. */
export function gzippedRecordings(manifest: readonly Entry[] = defaultManifest, ctx = context()) {
  const read = manifest.flatMap((e) => [
    ...(e.record ? [e.record.source] : []),
    ...(e.copy ?? []).filter((c) => c.record).map((c) => c.from),
  ]);
  return [...read.map((path) => relative(ctx.lab, resolve(ctx.app, path)).split(sep).join("/")), ...builderRecordings].filter(
    (path) => existsSync(resolve(ctx.lab, `${path}.gz`)),
  );
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Checks public/ against the manifest and describes all of it. Each record must survive a
 * jev-records-v1 round trip and its published copy must keep every source value (after the
 * entry's projection); each path is summarised by file count, bytes and one hash over its files.
 */
export function integrityIndex(manifest: readonly Entry[] = defaultManifest, ctx = context()) {
  const root = ctx.out(".");
  // vercel.json is read before the build, so it stays committed; it must match the manifest.
  const vercel: { headers: { source: string; headers: { key: string }[] }[] } = JSON.parse(readFileSync(resolve(ctx.app, "vercel.json"), "utf8"));
  const gzipRules = vercel.headers.filter((rule) => rule.headers.some((h) => h.key === "Content-Encoding")).map((rule) => rule.source);
  if (gzipRules.length !== 1 || gzipRules[0] !== gzipHeaderSource(manifest))
    throw Error(`vercel.json's gzip rule must be ${JSON.stringify(gzipHeaderSource(manifest))}`);
  const files = manifest
    .filter((entry) => entry.record)
    .map((entry) => {
      const spec = entry.record!,
        source = resolve(ctx.app, spec.source),
        output = ctx.out(recordPath(entry));
      if (!recordExists(source) || !existsSync(output)) throw Error(`Missing source or prepared output: ${entry.id}`);
      const original = readRecord(source),
        bytes = readFileSync(output),
        prepared = JSON.parse(bytes.toString("utf8"));
      if (JSON.stringify(decodeRecord(encodeRecord(original))) !== JSON.stringify(original))
        throw Error(`JSONL round trip changed ${entry.id}`);
      if (!prepared || typeof prepared !== "object") throw Error(`Invalid public JSON: ${entry.id}`);
      // A projected record is compared with the same projection of its source. Its derivation
      // is lineage metadata, not a claim that committed bytes are original data.
      const derivation = spec.projection?.derivation?.(original);
      assertPreserved(spec.projection ? spec.projection.project(original) : original, prepared, entry.id);
      return {
        name: entry.id,
        source: spec.source,
        // Hash the decompressed record, so a recording stored as .gz keeps its published hash.
        sourceSha256: sha(readRecordBytes(source)),
        publicSha256: sha(bytes),
        publicBytes: bytes.length,
        comparison: spec.projection ? "publication-source-derivative" : "original-record",
        ...(derivation ? { sourceDerivation: derivation } : {}),
        recipe: recipe(spec),
      };
    });
  const all = publicFiles(root),
    owners = new Map(all.map((file) => [file, ownerOf(file, manifest)]));
  const paths = manifest
    .filter((entry) => entry.path)
    .map((entry) => {
      const owned = all.filter((file) => owners.get(file) === entry && file !== recordPath(entry));
      if (!owned.length) throw Error(`Nothing published for ${entry.id} at public/${entry.path}`);
      const volatile = owned.filter((file) => entry.volatile?.includes(file));
      const digest = createHash("sha256");
      let bytes = 0;
      for (const file of owned) {
        const data = readFileSync(resolve(root, file));
        if (!volatile.includes(file)) {
          bytes += data.length;
          digest.update(`${file}\0${sha(data)}\n`);
        } else digest.update(`${file}\0volatile\n`);
      }
      return {
        name: entry.id,
        path: entry.path!,
        how: entry.committed ? "committed" : [entry.record?.build && "record build", entry.write && "write", entry.copy && "copy"].filter(Boolean).join(" + "),
        gzip: !!entry.gzip,
        files: owned.length,
        bytes,
        sha256: digest.digest("hex"),
        ...(volatile.length ? { unhashed: volatile } : {}),
      };
    });
  const unlisted = all.filter((file) => !owners.get(file));
  if (unlisted.length) throw Error(`Unlisted output: ${unlisted.join(", ")}`);
  return {
    schemaVersion: 4,
    publicationCount: files.length,
    publicFileCount: all.length,
    roundTripPassed: true,
    expectedFieldsPreserved: true,
    projectedPublications: files.filter((file) => file.comparison === "publication-source-derivative").map((file) => file.name),
    unlistedPublicFiles: unlisted,
    files,
    paths,
  };
}
