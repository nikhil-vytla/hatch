/** Loads the arena index once and any chunk on demand, caching both. */
import type { ArenaIndex, Card } from "../../../packages/arena/src/data/schema";

let index: Promise<ArenaIndex> | null = null;
const chunks = new Map<string, Promise<any>>();
export const loadIndex = () => (index ??= fetch("/arena/index.json").then((r) => { if (!r.ok) throw new Error("The arena data is not built. Run bun run build."); return r.json(); }));
export const loadChunk = <T = any>(path: string): Promise<T> => {
  if (!chunks.has(path)) chunks.set(path, fetch(`/arena/${path}`).then((r) => r.json()));
  return chunks.get(path)!;
};

/** Card view state, kept in the hash so any view can be shared. */
export type View = { card: string; c?: string[]; lens?: string; m?: string; g?: string; seed?: string; wf?: string; qt?: string };
export function readView(hash = location.hash): View | null {
  const m = hash.match(/^#\/arena(?:\/([^?]+))?(?:\?(.*))?$/);
  if (!m) return null;
  const p = new URLSearchParams(m[2] ?? "");
  const get = (k: string) => p.get(k) ?? undefined;
  return { card: m[1] ?? "", c: p.get("c")?.split(",").filter(Boolean), lens: get("lens"), m: get("m"), g: get("g"), seed: get("seed"), wf: get("wf"), qt: get("qt") };
}
export function writeView(v: View, replace = false) {
  const p = new URLSearchParams();
  if (v.c) p.set("c", v.c.join(","));
  for (const k of ["lens", "m", "g", "seed", "wf", "qt"] as const) if (v[k]) p.set(k, v[k]!);
  const q = p.toString().replaceAll("%2C", ","), hash = `#/arena${v.card ? `/${v.card}` : ""}${q ? `?${q}` : ""}`;
  if (hash === location.hash) return;
  if (replace) history.replaceState(null, "", hash); else history.pushState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** The default contestants for a card, limited to one protocol group. */
export function defaults(card: Card, group?: string) {
  const g = card.protocolGroups.find((x) => x.hash === group) ?? null;
  return card.contestants.filter((c) => c.default && (!g || c.kind === "code" || c.runSets.some((r) => g.runSets.includes(r)))).map((c) => c.id);
}

export const formatValue = (unit: string, v: number | undefined | null) => {
  if (v == null || Number.isNaN(v)) return "—";
  if (unit === "%") return `${(v * 100).toFixed(1)}%`;
  if (unit === "ms") return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
  if (unit === "s") return `${v.toFixed(1)} s`;
  if (unit === "lines" || unit === "pieces" || unit === "count") return Number.isInteger(v) ? String(v) : v.toFixed(1);
  return v.toFixed(3);
};
