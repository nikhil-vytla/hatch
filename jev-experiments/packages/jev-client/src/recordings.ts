/**
 * Reading recordings: the JSONL files recorders append to (one row per attempt) and builders
 * read back. Node only.
 *
 * Large committed recordings are stored gzipped (`foo.jsonl.gz`). Readers name the plain path;
 * an uncompressed working copy wins when present (recorders append to it), else the `.gz`.
 * The bytes returned are always the decompressed content, so hashes of records don't change.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Answers } from "./wire.js";

/** One recorded attempt. Recorders add their own fields; these are the common ones. */
export type RecordedRow = {
  id: string;
  at: string;
  status: "ok" | "error" | "rejected" | (string & {});
  latencyMs?: number;
  inputTokens?: number | null;
  costUsd?: number | null;
  servedBy?: string | null;
  model?: string | null;
  endpoint?: string;
  answers?: Answers;
  code?: number;
  message?: string;
  error?: string;
  [field: string]: unknown;
};

const plain = (path: string | URL) => (path instanceof URL ? fileURLToPath(path) : path);

/** The file a reader of `path` gets: the plain working copy if present, else `path.gz`. */
export const recordFile = (path: string | URL) => {
  const p = plain(path);
  return existsSync(p) || !existsSync(`${p}.gz`) ? p : `${p}.gz`;
};
export const recordExists = (path: string | URL) => existsSync(plain(path)) || existsSync(`${plain(path)}.gz`);
export function readRecordBytes(path: string | URL): Buffer {
  const file = recordFile(path);
  const bytes = readFileSync(file);
  return file.endsWith(".gz") ? gunzipSync(bytes) : bytes;
}
export const readRecordText = (path: string | URL) => readRecordBytes(path).toString("utf8");
/** Copies a recording's decompressed bytes to `target` (for files the site serves as-is). */
export const copyRecord = (path: string | URL, target: string) => writeFileSync(target, readRecordBytes(path));
/**
 * Before a recorder appends to a gzipped recording, unpack it into its uncompressed working copy
 * (gitignored), so new rows land after the old ones. Returns the plain path to append to.
 */
export function unpackForAppend(path: string | URL): string {
  const p = plain(path);
  if (!existsSync(p) && existsSync(`${p}.gz`)) writeFileSync(p, gunzipSync(readFileSync(`${p}.gz`)));
  return p;
}
/** Writes `path.gz` from the working copy. Deterministic: Node's gzip header carries no timestamp. */
export const compressRecord = (path: string | URL) =>
  writeFileSync(`${plain(path)}.gz`, gzipSync(readFileSync(plain(path)), { level: 9 }));

/** JSONL text as rows; blank lines are skipped. */
export const parseRows = <T = RecordedRow>(text: string): T[] =>
  text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

/**
 * Every row of a recording, oldest first; [] when there is none. A path ending in `.gz` reads
 * that file; any other path follows the working-copy rule above.
 */
export function readRows<T = RecordedRow>(path: string | URL): T[] {
  const p = plain(path);

  if (p.endsWith(".gz")) return existsSync(p) ? parseRows<T>(gunzipSync(readFileSync(p)).toString("utf8")) : [];

  return recordExists(p) ? parseRows<T>(readRecordText(p)) : [];
}

export const isOk = (row: { status?: unknown }) => row.status === "ok";

/**
 * The latest row per id among those `keep` accepts (by default, answered rows: failures are
 * excluded). A request is logged once per attempt; the last answered attempt stands.
 */
export function latestById<T>(
  rows: T[],
  keep: (row: T) => boolean = isOk as (row: T) => boolean,
  idOf: (row: T) => string = (row) => (row as { id: string }).id,
): Map<string, T> {
  const out = new Map<string, T>();

  for (const row of rows) if (keep(row)) out.set(idOf(row), row);

  return out;
}

const pct = (xs: number[], q: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : NaN);

/** The receipt for a recording: calls, tokens, cost (every attempt), latency percentiles (answered). */
export function receipt(rows: RecordedRow[]) {
  const ok = rows.filter(isOk);
  const lat = ok
    .map((r) => r.latencyMs ?? NaN)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  return {
    attempts: rows.length,
    ok: ok.length,
    errors: rows.length - ok.length,
    inputTokens: ok.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
    costUsd: rows.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    latencyMs: { p50: pct(lat, 0.5), p90: pct(lat, 0.9), p99: pct(lat, 0.99) },
    endpoints: [...new Set(ok.map((r) => r.endpoint ?? r.servedBy ?? "unknown"))],
  };
}

export function receiptLine(rows: RecordedRow[]) {
  const r = receipt(rows);

  return `${r.ok} ok of ${r.attempts} attempts · ${r.inputTokens.toLocaleString("en")} input tokens · $${r.costUsd.toFixed(6)} · p50 ${r.latencyMs.p50} ms · p90 ${r.latencyMs.p90} ms · p99 ${r.latencyMs.p99} ms`;
}
