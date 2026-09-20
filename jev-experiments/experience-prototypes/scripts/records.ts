import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";

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

export const readRecord = (path: string | URL) =>
  decodeRecord(readFileSync(path, "utf8"));
export function writeRecord(path: string, document: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, encodeRecord(document));
  renameSync(temporary, path);
}
