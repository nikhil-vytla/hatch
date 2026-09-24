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

  /** Best model per metric; code players are references and never win a tile. Ties keep every name. */
  const tiles: Tile[] =
    card.family === "robustness"
      ? []
      : card.metrics.slice(0, 4).flatMap((m) => {
          const order = ranked(m, models.length ? models : shown);
          const best = order[0] && estimate(order[0], m);

          if (!best) return [];

          return [
            {
              metric: m,
              winners: order.filter((id) => estimate(id, m)?.value === best.value),
              estimate: best,
            },
          ];
        });

  /** One sentence about the figure on screen, rebuilt whenever the lineup, metric or slice changes. */
  const finding = (() => {
    const order = ranked(metric, models.length ? models : shown);

    if (!order.length) return "";
    const lead = order[0];
    const last = order[order.length - 1];

    const parts = [
      order.length > 1
        ? `${nameOf(lead, true)} ${card.family === "robustness" ? "moves least" : "leads"} on ${inSentence(metric.label)} with ${formatValue(metric, estimate(lead))}. ${nameOf(last, true)} ${card.family === "robustness" ? "moves most" : "trails"} with ${formatValue(metric, estimate(last))}.`
        : `${nameOf(lead, true)}: ${formatValue(metric, estimate(lead))} ${inSentence(metric.label)}.`,
    ];

    const refs = ranked(metric, shown.filter(isCode));

    if (refs.length)
      parts.push(
        `${refs.length === 1 ? "Code reference:" : "Code references:"} ${refs.map((id) => `${nameOf(id, true)} ${formatValue(metric, estimate(id))}`).join(", ")}.`,
      );

    if (metric.timing && shown.some(isCode))
      parts.push("Code players make no model calls, so they have no time here.");

    return parts.join(" ");
  })();

  const protocolsInView = new Set(
    ids
      .flatMap((id) => contestant(id)?.runSets ?? [])
      .flatMap((rs) => {
        const g = card.protocolGroups.find((p) => p.runSets.includes(rs));

        return g ? [g.hash] : [];
      }),
  );

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
      return `${metric.label} on each seed. Every contestant gets the same pieces in the same order; bold marks the best on that seed.`;
    case "scatter":
      return `${y.label} against ${inSentence(x.label)}. Better is up and to the right on both axes; the dashed line joins contestants nobody beats on both.`;
    case "table":
      return "Every measure for the contestants in this figure. Select a column heading to sort.";
    case "reliability":
      return "Each dot is a confidence bin, sized by how many decisions fall in it. Dots on the diagonal mean stated confidence matches how often the top answer agrees with the reference.";
    case "case":
      return "One case: the reference distribution beside each contestant's. An outline marks an answer that is confident and disagrees.";
    case "board":
      return `Recorded games replayed side by side on seed ${view.seed ?? card.items?.[0]?.id ?? ""}. Every lane gets the same pieces; the faces show how each player is doing.`;
  }
}
