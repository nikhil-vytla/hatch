/** PROTOTYPE: identity variants for the arena. Throwaway; see README.md in this folder. */
import { useEffect } from "react";
import type { Card } from "../../../../packages/arena/src/data/schema";
import { defaults, formatValue, writeView, type View } from "../data";
import { better } from "../card";

export const VARIANTS = [
  { key: "A", name: "Instrument" },
  { key: "B", name: "Storybook" },
  { key: "C", name: "Field journal" },
] as const;

/** The default lineup's ranking on the primary metric, with a one-sentence finding. */
export function standings(card: Card) {
  const metric = card.metrics.find((m) => m.id === card.primary)!;
  const ids = defaults(card, card.protocolGroups.at(-1)?.hash).filter((id) => card.results[id]?.[metric.id]);
  const rows = ids.map((id) => ({ id, c: card.contestants.find((x) => x.id === id)!, e: card.results[id][metric.id] })).sort((a, b) => better(metric, a.e.value, b.e.value));
  const models = rows.filter((r) => r.c.kind !== "code");
  const lead = models[0] ?? rows[0], last = models.at(-1);
  const finding = lead && last && lead !== last
    ? `${lead.c.short} ${metric.better === "higher" ? "leads" : "does best"} on ${metric.label.toLowerCase()} with ${formatValue(metric.unit, lead.e.value)}; ${last.c.short} ${metric.better === "higher" ? "trails" : "does worst"} with ${formatValue(metric.unit, last.e.value)}.`
    : lead ? `${lead.c.short}: ${formatValue(metric.unit, lead.e.value)} ${metric.label.toLowerCase()}.` : "";
  return { metric, rows, lead, finding };
}

/** A floating bar to flip between variants; shown only when a variant is requested. */
export function Switcher({ view }: { view: View }) {
  const i = Math.max(0, VARIANTS.findIndex((v) => v.key === view.v));
  const go = (d: number) => writeView({ ...view, v: VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length].key }, true);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1); else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
  return (
    <div className="proto-switcher" role="toolbar" aria-label="Prototype variant">
      <button onClick={() => go(-1)} aria-label="Previous variant">←</button>
      <span>{VARIANTS[i].key} — {VARIANTS[i].name}</span>
      <button onClick={() => go(1)} aria-label="Next variant">→</button>
      <button onClick={() => writeView({ ...view, v: undefined }, true)} aria-label="Leave the prototype" className="proto-exit">×</button>
    </div>
  );
}

export const cardHref = (card: Card, view: View) => `#/arena/${card.id}${view.v ? `?v=${view.v}` : ""}`;
