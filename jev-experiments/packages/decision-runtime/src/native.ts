/** Native Jev entries preserve JSON structure. Numbers/booleans are allowed inside an entry. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Entry = string | null | Json[] | { [key: string]: Json };
export type EntryShape = "string" | "object" | "array" | "null";
export type NativeQuestion =
  | { type: "choice"; instructions: Entry; criteria: Record<string, Entry> }
  | { type: "noul"; instructions: Entry; criteria?: { true: Entry; false: Entry } }
  | { type: "score"; instructions: Entry; criteria: Entry[] };
export const JSON_LIMITS = { maxDepth: 32, maxNodes: 16_384, maxCollection: 1_024 };
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function entryShape(value: unknown): EntryShape | undefined {
  return value === null ? "null" : typeof value === "string" ? "string" :
    Array.isArray(value) ? "array" : isObject(value) ? "object" : undefined;
}
/** JSON equality ignores object key order; array order remains semantic. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}

/** Reject lossy serialization, cycles and oversized recursive values before transport. */
export function jsonIssue(value: unknown): string | null {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): string | null {
    if (++nodes > JSON_LIMITS.maxNodes) return "JSON exceeds the node limit.";
    if (depth > JSON_LIMITS.maxDepth) return "JSON exceeds the nesting limit.";
    if (item === null || typeof item === "string" || typeof item === "boolean") return null;
    if (typeof item === "number") return Number.isFinite(item) ? null : "JSON numbers must be finite.";
    if (typeof item !== "object") return "Only JSON values are supported.";
    if (ancestors.has(item)) return "JSON must not contain cycles.";
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      return "JSON objects must be plain records.";
    const keys = Reflect.ownKeys(item).filter(key => !(Array.isArray(item) && key === "length"));
    if (keys.length > JSON_LIMITS.maxCollection || (Array.isArray(item) && item.length > JSON_LIMITS.maxCollection))
      return "JSON collection exceeds the item limit.";
    if (Array.isArray(item) && keys.length !== item.length) return "JSON arrays must be dense.";
    ancestors.add(item);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
        return "JSON cannot contain symbols, accessors or hidden fields.";
      if (Array.isArray(item) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))
        return "JSON arrays cannot have named properties.";
      const error = visit(descriptor.value, depth + 1);
      if (error) return error;
    }
    ancestors.delete(item);
    return null;
  }
  try { return visit(value, 0); } catch { return "Invalid JSON structure."; }
}
export function nativeQuestionIssue(value: unknown): string | null {
  const issue = jsonIssue(value);
  if (issue) return issue;
  if (!isObject(value) || Object.keys(value).some(key => !["type", "instructions", "criteria"].includes(key)))
    return "Question contains unsupported fields.";
  if (!Object.hasOwn(value, "instructions") || !entryShape(value.instructions))
    return "Instructions must be a string, object, array or null.";
  if (new TextEncoder().encode(JSON.stringify(value.instructions)).length > 48_000)
    return "Question instructions exceed the byte limit.";
  const criteria = value.criteria;
  if (value.type === "noul") {
    if (criteria === undefined) return null;
    return isObject(criteria) && Object.keys(criteria).length === 2 &&
      Object.hasOwn(criteria, "true") && Object.hasOwn(criteria, "false") &&
      entryShape(criteria.true) && entryShape(criteria.false)
      ? null : "Noul criteria must contain true and false entries.";
  }
  if (value.type === "choice") {
    if (!isObject(criteria) || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 255 ||
      Object.keys(criteria).some(key => !key.trim()) || Object.values(criteria).some(entry => !entryShape(entry)))
      return "Choice needs 2–255 named JSON entries.";
    return null;
  }
  if (value.type === "score") {
    return Array.isArray(criteria) && criteria.length >= 2 && criteria.length <= 10 &&
      criteria.every(entry => !!entryShape(entry)) ? null : "Score needs 2–10 ordered JSON entries.";
  }
  return "Unknown question type.";
}
