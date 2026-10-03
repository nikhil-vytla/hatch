import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const format = "jev-records-v1";
type Entry = { path: string[]; index: number; value: unknown };

/** One array item per line; metadata keeps the exact original document shape. */
export function encodeRecord(document: unknown): string {
  const entries: Entry[] = [];
  function visit(value: any, path: string[]): any {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        entries.push({ path, index, value: item }),
      );
      return [];
    }
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          visit(item, [...path, key]),
        ]),
      );
    return value;
  }
  const skeleton = visit(document, []);
  return (
    [
      JSON.stringify({ format, document: skeleton }),
      ...entries.map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n"
  );
}

export function decodeRecord(text: string): any {
  const lines = text.trimEnd().split("\n");
  const header = JSON.parse(lines.shift()!);
  if (header.format !== format || !Object.hasOwn(header, "document"))
    throw new Error("Unknown result format.");
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (
      !Array.isArray(entry.path) ||
      !entry.path.every((key: unknown) => typeof key === "string") ||
      !Number.isSafeInteger(entry.index) ||
      !Object.hasOwn(entry, "value")
    )
      throw new Error("Invalid result entry.");
    let target = header.document;
    for (const key of entry.path) {
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
        throw new Error("Invalid result path.");
      target = target[key];
    }
    if (!Array.isArray(target) || entry.index !== target.length)
      throw new Error("Result entries must be ordered and contiguous.");
    target.push(entry.value);
  }
  return header.document;
}

/**
 * Large committed recordings are stored gzipped (`foo.jsonl.gz`). Readers name the plain path;
 * an uncompressed working copy wins when present (recorders append to it), else the `.gz`.
 * The bytes returned are always the decompressed content, so hashes of records don't change.
 */
const plain = (path: string | URL) => (path instanceof URL ? fileURLToPath(path) : path);
export const recordFile = (path: string | URL) => {
  const p = plain(path);
  return existsSync(p) || !existsSync(`${p}.gz`) ? p : `${p}.gz`;
};
export const recordExists = (path: string | URL) =>
  existsSync(plain(path)) || existsSync(`${plain(path)}.gz`);
export function readRecordBytes(path: string | URL): Buffer {
  const file = recordFile(path);
  const bytes = readFileSync(file);
  return file.endsWith(".gz") ? gunzipSync(bytes) : bytes;
}
export const readRecordText = (path: string | URL) => readRecordBytes(path).toString("utf8");
/** Copies a recording's decompressed bytes to `target` (for files the site serves as-is). */
export const copyRecord = (path: string | URL, target: string) =>
  writeFileSync(target, readRecordBytes(path));
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

export const readRecord = (path: string | URL) =>
  decodeRecord(readRecordText(path));
/** Writes a record; a recording stored only as `.gz` is rewritten as `.gz`. */
export function writeRecord(path: string, document: unknown) {
  const gz = !existsSync(path) && existsSync(`${path}.gz`);
  const target = gz ? `${path}.gz` : path;
  const temporary = `${target}.${randomUUID()}.tmp`;
  const text = encodeRecord(document);
  writeFileSync(temporary, gz ? gzipSync(text, { level: 9 }) : text);
  renameSync(temporary, target);
}
