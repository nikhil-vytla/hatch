/** Loads the arena index and chunks, parsing each at the boundary, and keeps view state in the URL. */
import type { z } from "zod";
import {
  arenaIndexSchema,
  type ArenaIndex,
  type Card,
  type Estimate,
  type MetricDef,
} from "../../../packages/arena/src/data/schema";

let index: Promise<ArenaIndex> | null = null;

const chunks = new Map<string, Promise<unknown>>();

export function loadIndex(): Promise<ArenaIndex> {
  index ??= fetch("/arena/index.json")
    .then((r) => {
      if (!r.ok) throw new Error(`arena/index.json: HTTP ${r.status}`);

      return r.json();
    })
    .then((json) => {
      const parsed = arenaIndexSchema.safeParse(json);

      if (parsed.success) return parsed.data;
      console.error("arena/index.json does not match its schema", parsed.error.issues);
      throw new Error("arena/index.json does not match its schema");
    });

  return index;
}

/** Fetches a chunk once and parses it with the caller's schema. */
export function loadChunk<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  let pending = chunks.get(path);

  if (!pending) {
    pending = fetch(`/arena/${path}`).then((r) => r.json());
    chunks.set(path, pending);
  }

  return pending.then((json) => schema.parse(json));
}

/** Card view state, kept in the hash so any view can be shared. */
export type View = {
  card: string;
  c?: string[];
  lens?: string;
  m?: string;
  g?: string;
  seed?: string;
  wf?: string;
  qt?: string;
};

const KEYS = ["lens", "m", "g", "seed", "wf", "qt"] as const;

export function readView(hash = location.hash): View | null {
  const match = hash.match(/^#\/arena(?:\/([^?]+))?(?:\?(.*))?$/);

  if (!match) return null;
  const params = new URLSearchParams(match[2] ?? "");
  const view: View = { card: match[1] ?? "", c: params.get("c")?.split(",").filter(Boolean) };

  for (const key of KEYS) {
    const value = params.get(key);

    if (value) view[key] = value;
  }

  return view;
}

export function viewHash(view: View) {
  const params = new URLSearchParams();

  if (view.c) params.set("c", view.c.join(","));

  for (const key of KEYS) {
    const value = view[key];

    if (value) params.set(key, value);
  }

  const query = params.toString().replaceAll("%2C", ",");

  return `#/arena${view.card ? `/${view.card}` : ""}${query ? `?${query}` : ""}`;
}

/** Contestant changes add a history entry; lens, metric and slice changes replace it. */
export function writeView(view: View, mode: "push" | "replace" = "replace") {
  const hash = viewHash(view);

  if (hash === location.hash) return;

  if (mode === "push") history.pushState(null, "", hash);
  else history.replaceState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Default contestants for a card, limited to one protocol group. */
export function defaults(card: Card, group?: string) {
  const selected = card.protocolGroups.find((g) => g.hash === group);

  return card.contestants
    .filter(
      (c) =>
        c.default &&
        (!selected || c.kind === "code" || c.runSets.some((r) => selected.runSets.includes(r))),
    )
    .map((c) => c.id);
}

/**
 * Formats a number in its metric's unit. Means over seeds keep one decimal so a
 * column of means aligns; raw counts stay whole.
 */
export function formatNumber(metric: Pick<MetricDef, "unit">, value?: number, mean = false) {
  if (value === undefined || Number.isNaN(value)) return "—";

  switch (metric.unit) {
    case "%":
      return `${(value * 100).toFixed(1)}%`;
    case "ms":
      return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
    case "s":
      return `${value.toFixed(1)} s`;
    case "lines":
    case "pieces":
    case "count":
      return mean || !Number.isInteger(value) ? value.toFixed(1) : String(value);
    default:
      return value.toFixed(3);
  }
}

/** Formats an estimate; per-seed estimates are means. */
export const formatValue = (metric: Pick<MetricDef, "unit">, estimate?: Estimate) =>
  formatNumber(metric, estimate?.value, Boolean(estimate?.perItem));

/** "±2.2pp" for percentages, "±0.004" otherwise; empty when there is no interval. */
export function formatSpread(metric: Pick<MetricDef, "unit">, estimate?: Estimate) {
  if (estimate?.lo === undefined || estimate.hi === undefined) return "";
  const half = (estimate.hi - estimate.lo) / 2;

  return metric.unit === "%" ? `±${(half * 100).toFixed(1)}pp` : `±${formatNumber(metric, half)}`;
}

/** Lowercases only a leading capital that begins a normal word, so "P(clean)" survives. */
export function inSentence(label: string) {
  return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}
