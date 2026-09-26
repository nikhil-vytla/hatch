/** Everything a card view derives from its data and the URL, shared by every lens. */
import { useMemo, useState, type CSSProperties } from "react";
import type {
  Card,
  CardContestant,
  Estimate,
  Lens,
  MetricDef,
} from "../../../packages/arena/src/data/schema";
import { defaults, formatValue, inSentence, writeView, type View } from "./data";

export const LIVE_ID = "jev.live";

export const MAX_CONTESTANTS = 6;

export const LIVE_CONTESTANT: CardContestant = {
  id: LIVE_ID,
  name: "Jev · live (your key)",
  short: "Jev live",
  kind: "hosted",
  model: "typesafe-ai/jev",
  policy: "judges each spot, remembering confident judgements; plays on the Watch view only",
  color: { light: "#0b5c38", dark: "#9be6bd" },
  default: false,
  runSets: [],
};

export const LENS_LABEL: Record<Lens, string> = {
  bars: "Bars",
  scatter: "Trade-off",
  "per-item": "Per seed",
  table: "Table",
  reliability: "Calibration",
  board: "Watch",
  case: "Case",
  typing: "Watch",
};

/** Negative when `a` is better than `b`. */
export const compareBy = (m: MetricDef, a: number, b: number) =>
  m.better === "higher" ? b - a : a - b;

/** Inline CSS variables giving an element its contestant colour in both themes. */
export const colorVars = (
  c?: Pick<CardContestant, "color">,
): CSSProperties & Partial<Record<"--c-l" | "--c-d", string>> =>
  c ? { "--c-l": c.color.light, "--c-d": c.color.dark } : {};

export type Tile = { metric: MetricDef; winners: string[]; estimate: Estimate };

export function useCardModel(card: Card, view: View, hasKey: boolean) {
  const pool = useMemo(
    () => [...card.contestants, ...(card.family === "game" && hasKey ? [LIVE_CONTESTANT] : [])],
    [card, hasKey],
  );

  const byId = useMemo(() => new Map(pool.map((c) => [c.id, c])), [pool]);
  const requested = view.c?.filter((id) => byId.has(id)) ?? [];
  const dropped = (view.c ?? []).filter((id) => !byId.has(id));
  const group = view.g ?? card.protocolGroups.at(-1)?.hash;
  const ids = requested.length ? requested : defaults(card, group);
  const lens: Lens = card.lenses.find((l) => l === view.lens) ?? card.lenses[0];

  const metric =
    card.metrics.find((m) => m.id === view.m) ??
    card.metrics.find((m) => m.id === card.primary) ??
    card.metrics[0];

  const results = useMemo(() => {
    const wf = view.wf ? card.slices?.workflow?.[view.wf] : undefined;
    const qt = view.qt ? card.slices?.type?.[view.qt] : undefined;

    return wf ?? qt ?? card.results;
  }, [card, view.wf, view.qt]);

  const contestant = (id: string) => byId.get(id);

  const nameOf = (id: string, short = false) =>
    (short ? contestant(id)?.short : contestant(id)?.name) ?? id;

  /** The short name when no other contestant on the card shares it, otherwise the full name. */
  const label = (id: string) => {
    const short = contestant(id)?.short;

    return short && pool.filter((c) => c.short === short).length === 1 ? short : nameOf(id);
  };

  /** What this card compares: robustness entries set conditions side by side, not contestants. */
  const noun = card.family === "robustness" ? "condition" : "contestant";
  const isCode = (id: string) => contestant(id)?.kind === "code";
  const estimate = (id: string, m: MetricDef = metric) => results[id]?.[m.id];
  const shown = ids.filter((id) => results[id]);
  const models = shown.filter((id) => !isCode(id));

  const ranked = (m: MetricDef, among: string[]) =>
    among
      .flatMap((id) => {
        const e = estimate(id, m);

        return e ? [{ id, value: e.value }] : [];
      })
      .sort((a, b) => compareBy(m, a.value, b.value))
      .map((r) => r.id);

  /**
   * Best model per metric; code players are references and never win a tile. Ties keep every
   * name. With fewer than two models there is nobody to beat, and a measure where every model
   * scores the same says nothing, so neither gets a tile.
   */
  const tiles: Tile[] =
    card.family === "robustness" || models.length < 2
      ? []
      : card.metrics.slice(0, 4).flatMap((m) => {
          const order = ranked(m, models);
          const best = order[0] && estimate(order[0], m);
          const worst = order.length && estimate(order[order.length - 1], m);

          if (!best || !worst || order.length < 2 || best.value === worst.value) return [];

          return [
            {
              metric: m,
              winners: order.filter((id) => estimate(id, m)?.value === best.value),
              estimate: best,
            },
          ];
        });

  const protocolsInView = new Set(
    ids
      .flatMap((id) => contestant(id)?.runSets ?? [])
      .flatMap((rs) => {
        const g = card.protocolGroups.find((p) => p.runSets.includes(rs));

        return g ? [g.hash] : [];
      }),
  );

  /**
   * One sentence about the figure on screen, rebuilt whenever the lineup, metric or slice changes.
   * It says "leads" only when the 95% intervals separate; otherwise it gives the numbers and hedges.
   */
  const finding = (() => {
    const order = ranked(metric, models.length ? models : shown);

    if (!order.length) return "";
    const lead = order[0];
    const last = order[order.length - 1];

    const a = estimate(lead),
      b = estimate(last);

    const robust = card.family === "robustness";
    const parts: string[] = [];

    if (protocolsInView.size > 1)
      parts.push(
        "This lineup mixes runs recorded under different protocols, so compare with care.",
      );

    if (order.length === 1 || !a || !b) {
      parts.push(`${metric.label}: ${label(lead)} ${formatValue(metric, a)}.`);
    } else {
      const separated =
        a.lo !== undefined &&
        a.hi !== undefined &&
        b.lo !== undefined &&
        b.hi !== undefined &&
        (a.lo > b.hi || b.lo > a.hi);

      const values = `${label(lead)} ${formatValue(metric, a)}, ${label(last)} ${formatValue(metric, b)}`;

      if (robust)
        parts.push(
          `${label(lead)} moved judgements least (${formatValue(metric, a)} ${inSentence(metric.label)}); ${inSentence(label(last))} moved them most (${formatValue(metric, b)}).${separated ? "" : " Their 95% intervals overlap, so this is not a clear gap."}`,
        );
      else if (separated)
        parts.push(
          `${metric.label}: ${label(lead)} leads with ${formatValue(metric, a)}; ${label(last)} trails with ${formatValue(metric, b)}. Their 95% intervals do not overlap.`,
        );
      else if (a.lo !== undefined && b.lo !== undefined)
        parts.push(
          `${metric.label}: ${values}. Their 95% intervals overlap, so this is not a clear gap.`,
        );
      else if (a.perItem)
        parts.push(
          `${metric.label}: ${values} (means of ${a.perItem.length} seeds${a.perItem.length < 5 ? ", too few to call a clear gap" : ""}).`,
        );
      else parts.push(`${metric.label}: ${values}.`);
    }

    const refs = ranked(metric, shown.filter(isCode));

    if (refs.length)
      parts.push(
        `${refs.length === 1 ? "Code reference:" : "Code references:"} ${refs.map((id) => `${label(id)} ${formatValue(metric, estimate(id))}`).join(", ")}.`,
      );

    if (metric.timing && shown.some(isCode))
      parts.push("Code players make no model calls, so they have no time here.");

    return parts.join(" ");
  })();

  const set = (patch: Partial<View>, mode: "push" | "replace" = "replace") =>
    writeView({ ...view, card: card.id, ...patch }, mode);

  const [focus, setFocus] = useState<string | null>(null);

  return {
    card,
    view,
    pool,
    ids,
    dropped,
    lens,
    metric,
    results,
    shown,
    models,
    tiles,
    finding,
    protocolsInView,
    focus,
    setFocus,
    set,
    contestant,
    nameOf,
    label,
    noun,
    isCode,
    estimate,
    ranked,
  };
}

export type CardModel = ReturnType<typeof useCardModel>;

/** What each lens shows, written for the figure caption. */
export function caption(m: CardModel) {
  const { card, metric, lens, view } = m;

  const [x, y] = (
    card.tradeoff ?? [card.metrics[0].id, card.metrics[1]?.id ?? card.metrics[0].id]
  ).map((id) => card.metrics.find((mm) => mm.id === id) ?? card.metrics[0]);

  switch (lens) {
    case "bars":
      return `${metric.help} ${metric.better === "higher" ? "Longer bars are better." : "Shorter bars are better."}`;
    case "per-item":
      return `${metric.label} on each seed. Every ${m.noun} gets the same pieces in the same order; bold marks the best on that seed.`;
    case "scatter":
      return `${y.label} against ${inSentence(x.label)}. Better is up and to the right on both axes. Filled circles are models no other model beats on both; squares are code players, shown for reference.`;
    case "table":
      return "Every measure for the contestants in this figure. Select a column heading to sort.";
    case "reliability":
      return "Across: stated confidence. Up: how often the top answer agrees with the reference. Each dot is a confidence bin, sized by how many decisions fall in it; dots on the diagonal mean the confidence is honest.";
    case "case":
      return "One case: the reference distribution beside each contestant's. An outline marks an answer that is confident and disagrees.";
    case "typing":
      return "Each box receives the same keystrokes at the same pace. The strip under each box shows everything it showed over the phrase; the line marks now.";
    case "board":
      return `Recorded games replayed side by side on seed ${view.seed ?? card.items?.[0]?.id ?? ""}. Every lane gets the same pieces; the faces show how each player is doing.`;
  }
}
