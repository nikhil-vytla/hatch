import { scaleLinear } from "d3-scale";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { MetricDef } from "../../../packages/arena/src/data/schema";
import { predsSchema, targetsSchema } from "../../../packages/arena/src/data/chunks";
import { score } from "../../../packages/arena/src/score";
import { formatNumber, formatSpread, formatValue, inSentence, loadChunk, tickFormat } from "./data";
import { colorVars, compareBy, type CardModel } from "./model";
import { TableScroll } from "./table";

const domainOf = (m: MetricDef): [number, number] => m.domain ?? [0, m.unit === "%" ? 1 : 1];

/** A screen-reader copy of the figure's numbers. */
function DataTable({ model: m, metrics }: { model: CardModel; metrics: MetricDef[] }) {
  return (
    <div className="sr-only">
      <table>
        <caption>{m.card.title}</caption>
        <thead>
          <tr>
            <th scope="col">{m.noun === "condition" ? "Condition" : "Contestant"}</th>
            {metrics.map((mm) => (
              <th key={mm.id} scope="col">
                {mm.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.shown.map((id) => (
            <tr key={id}>
              <th scope="row">{m.nameOf(id)}</th>
              {metrics.map((mm) => (
                <td key={mm.id}>
                  {formatValue(mm, m.estimate(id, mm))} {formatSpread(mm, m.estimate(id, mm))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- bars
export function Bars({ model: m }: { model: CardModel }) {
  const metric = m.metric;
  const x = scaleLinear().domain(domainOf(metric)).range([0, 100]).clamp(true);
  const ticks = x.ticks(4);
  const tick = tickFormat(metric, ticks);
  const rows = m.ranked(metric, m.shown);
  const missing = m.shown.filter((id) => !rows.includes(id));
  const focused = m.focus ? m.estimate(m.focus) : undefined;
  const pct = (v: number) => `${x(v)}%`;

  return (
    <>
      <div
        className="bars"
        role="list"
        aria-label={`${metric.label} by ${m.noun}`}
        onMouseLeave={() => m.setFocus(null)}
      >
        {rows.map((id) => {
          const e = m.estimate(id);
          const c = m.contestant(id);

          if (!e) return null;

          const detail = e.perItem
            ? `Seeds: ${e.perItem.map((p) => `${p.item} ${formatNumber(metric, p.value)}`).join(", ")}`
            : e.lo !== undefined && e.hi !== undefined
              ? `95% interval ${formatNumber(metric, e.lo)} to ${formatNumber(metric, e.hi)} over ${e.n} cases`
              : "";

          const spread = formatSpread(metric, e);

          // A focusable list item, not a button: focusing shows the detail, there is nothing to press.
          return (
            <div
              key={id}
              role="listitem"
              tabIndex={0}
              className="bar-row"
              data-dim={m.focus !== null && m.focus !== id}
              data-kind={c?.kind}
              style={colorVars(c)}
              aria-label={`${m.nameOf(id)}, ${formatValue(metric, e)}${spread ? ` ${spread}` : ""}`}
              aria-describedby={detail ? `bar-detail-${id}` : undefined}
              onMouseEnter={() => m.setFocus(id)}
              onFocus={() => m.setFocus(id)}
              onBlur={() => m.setFocus(null)}
            >
              <span className="bar-name" aria-hidden="true">
                <span className="swatch" />
                {m.nameOf(id)}
                {e.coverage && (
                  <small>
                    {" "}
                    · {e.coverage.covered} of {e.coverage.of} seeds
                  </small>
                )}
              </span>
              <span className="bar-track" aria-hidden="true">
                {focused?.lo !== undefined && focused.hi !== undefined && (
                  <span
                    className="bar-band"
                    style={{
                      left: pct(focused.lo),
                      width: `calc(${pct(focused.hi)} - ${pct(focused.lo)})`,
                    }}
                  />
                )}
                <span className="bar-fill" style={{ width: pct(e.value) }} />
                {e.lo !== undefined && e.hi !== undefined && (
                  <span
                    className="bar-whisker"
                    style={{ left: pct(e.lo), width: `calc(${pct(e.hi)} - ${pct(e.lo)})` }}
                  />
                )}
                {e.perItem?.map((p) => (
                  <span key={p.item} className="bar-seed" style={{ left: pct(p.value) }} />
                ))}
              </span>
              <span className="bar-value" aria-hidden="true">
                {formatValue(metric, e)}
                <small>{spread || (e.perItem ? `mean of ${e.perItem.length}` : "")}</small>
              </span>
              <span
                id={`bar-detail-${id}`}
                className="bar-detail"
                data-open={m.focus === id}
                aria-hidden="true"
              >
                {detail}
              </span>
            </div>
          );
        })}
        <div className="bar-axis" aria-hidden="true">
          <span />
          <span className="bar-ticks">
            {ticks.map((t) => (
              <span key={t} style={{ left: pct(t) }}>
                {tick(t)}
              </span>
            ))}
          </span>
          <em className="bar-better">{metric.better === "lower" ? "← better" : "better →"}</em>
        </div>
      </div>
      {missing.length > 0 && (
        <p className="muted">
          No {inSentence(metric.label)} for {missing.map((id) => m.label(id)).join(", ")}
          {metric.timing ? ": code players make no model calls." : "."}
        </p>
      )}
      <DataTable model={m} metrics={[metric]} />
    </>
  );
}

// ---------------------------------------------------------------- scatter
/** The element's content width, following resizes. */
function useWidth(ref: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const el = ref.current;

    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));

    observer.observe(el);

    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/** From zero (or the lowest value, if negative) to a little past the highest value. */
function extent(values: number[], metric: MetricDef): [number, number] {
  const lo = Math.min(0, ...values),
    hi = Math.max(...values);

  if (!(hi > lo)) return domainOf(metric);

  return [lo, hi + (hi - lo) * 0.12];
}

type Point = { id: string; x: number; y: number };

/** Points nobody beats on both measures. */
function frontier(points: Point[], mx: MetricDef, my: MetricDef) {
  const beats = (a: Point, b: Point) =>
    compareBy(mx, a.x, b.x) <= 0 && compareBy(my, a.y, b.y) <= 0 && (a.x !== b.x || a.y !== b.y);

  return points.filter((p) => !points.some((q) => beats(q, p)));
}

export function Scatter({ model: m }: { model: CardModel }) {
  const [xId, yId] = m.card.tradeoff ?? [
    m.card.metrics[0].id,
    m.card.metrics[1]?.id ?? m.card.metrics[0].id,
  ];

  const mx = m.card.metrics.find((mm) => mm.id === xId) ?? m.card.metrics[0];
  const my = m.card.metrics.find((mm) => mm.id === yId) ?? m.card.metrics[0];

  const points: Point[] = m.shown.flatMap((id) => {
    const ex = m.estimate(id, mx),
      ey = m.estimate(id, my);

    return ex && ey ? [{ id, x: ex.value, y: ey.value }] : [];
  });

  const skipped = m.shown.filter((id) => !points.some((p) => p.id === id));

  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);

  // Drawn at its real width so text stays at its CSS size on phones and when zoomed.
  const W = Math.max(280, Math.min(820, width)),
    narrow = W < 520,
    H = narrow ? 280 : 340,
    L = narrow ? 44 : 56,
    R = 24,
    T = 20,
    B = 48;

  // Better is always up and to the right: flip an axis whose smaller values are better.
  // The range comes from the points (keeping zero) so small differences stay visible.
  const [dx0, dx1] = extent(
      points.map((p) => p.x),
      mx,
    ),
    [dy0, dy1] = extent(
      points.map((p) => p.y),
      my,
    );

  const x = scaleLinear()
    .domain(mx.better === "higher" ? [dx0, dx1] : [dx1, dx0])
    .range([L, W - R])
    .nice();

  const y = scaleLinear()
    .domain(my.better === "higher" ? [dy0, dy1] : [dy1, dy0])
    .range([H - B, T])
    .nice();

  const tickX = tickFormat(mx, x.ticks(narrow ? 3 : 5)),
    tickY = tickFormat(my, y.ticks(5));

  const front = frontier(
    points.filter((p) => !m.isCode(p.id)),
    mx,
    my,
  ).sort((a, b) => x(a.x) - x(b.x));

  // Keep labels at least 15px apart vertically, with a leader line when one moves.
  const labels = [...points]
    .map((p) => ({ ...p, sx: x(p.x), sy: y(p.y), ly: y(p.y) }))
    .sort((a, b) => a.sy - b.sy);

  for (let i = 1; i < labels.length; i++)
    if (
      Math.abs(labels[i].sx - labels[i - 1].sx) < (narrow ? 120 : 180) &&
      labels[i].ly - labels[i - 1].ly < 15
    )
      labels[i].ly = labels[i - 1].ly + 15;

  if (points.length < 2)
    return (
      <div ref={box}>
        <p className="muted">
          Add at least two contestants that have both {inSentence(mx.label)} and{" "}
          {inSentence(my.label)}.
        </p>
      </div>
    );

  return (
    <div className="scatter" ref={box}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label={`${my.label} against ${inSentence(mx.label)}`}
        onMouseLeave={() => m.setFocus(null)}
      >
        {x.ticks(narrow ? 3 : 5).map((t) => (
          <g key={`x${t}`} className="tick">
            <line x1={x(t)} x2={x(t)} y1={T} y2={H - B} />
            <text x={x(t)} y={H - B + 18} textAnchor="middle">
              {tickX(t)}
            </text>
          </g>
        ))}
        {y.ticks(5).map((t) => (
          <g key={`y${t}`} className="tick">
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end">
              {tickY(t)}
            </text>
          </g>
        ))}
        <text className="axis-title" x={W - R} y={H - 8} textAnchor="end">
          {mx.label} ({mx.better === "higher" ? "higher" : "lower"} is better) →
        </text>
        <text className="axis-title" x={L} y={T - 6}>
          ↑ {my.label} ({my.better === "higher" ? "higher" : "lower"} is better)
        </text>
        {front.length > 1 && (
          <polyline
            className="frontier"
            points={front.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")}
          />
        )}
        {labels.map((p) => {
          const onFront = front.some((f) => f.id === p.id);
          const c = m.contestant(p.id);
          const right = p.sx < W * 0.6;
          const code = m.isCode(p.id);

          return (
            <g
              key={p.id}
              className="point"
              data-dim={m.focus !== null && m.focus !== p.id}
              data-front={onFront}
              style={colorVars(c)}
              tabIndex={0}
              role="img"
              aria-label={`${m.nameOf(p.id)}${code ? " (code reference)" : ""}: ${formatNumber(mx, p.x)} ${inSentence(mx.label)}, ${formatNumber(my, p.y)} ${inSentence(my.label)}${onFront ? ", on the frontier" : ""}`}
              onMouseEnter={() => m.setFocus(p.id)}
              onFocus={() => m.setFocus(p.id)}
              onBlur={() => m.setFocus(null)}
            >
              {p.ly !== p.sy && (
                <line
                  className="leader"
                  x1={p.sx}
                  y1={p.sy}
                  x2={p.sx + (right ? 10 : -10)}
                  y2={p.ly}
                />
              )}
              {code ? (
                <rect x={p.sx - 6} y={p.sy - 6} width={12} height={12} />
              ) : (
                <circle cx={p.sx} cy={p.sy} r={7} />
              )}
              <text x={p.sx + (right ? 12 : -12)} y={p.ly + 4} textAnchor={right ? "start" : "end"}>
                {m.label(p.id)}
                {!narrow && (
                  <tspan className="point-value">
                    {" "}
                    {formatNumber(mx, p.x)} · {formatNumber(my, p.y)}
                  </tspan>
                )}
              </text>
            </g>
          );
        })}
      </svg>
      {skipped.length > 0 && (
        <p className="muted">
          Not plotted: {skipped.map((id) => m.label(id)).join(", ")}
          {mx.timing || my.timing
            ? ", code players make no model calls."
            : ", no value for one axis."}
        </p>
      )}
      <DataTable model={m} metrics={[mx, my]} />
    </div>
  );
}

// ---------------------------------------------------------------- per seed
export function PerSeed({ model: m }: { model: CardModel }) {
  const metric = m.metric;
  const items = m.card.items ?? [];
  const lead = m.ranked(metric, m.models.length ? m.models : m.shown)[0];

  const per = (id: string, item: string) =>
    m.estimate(id)?.perItem?.find((p) => p.item === item)?.value;

  return (
    <TableScroll>
      <table className="results">
        <thead>
          <tr>
            <th scope="col">{m.noun === "condition" ? "Condition" : "Contestant"}</th>
            {items.map((it) => (
              <th key={it.id} scope="col">
                {it.label}
              </th>
            ))}
            {lead && <th scope="col">Against {m.label(lead)}</th>}
          </tr>
        </thead>
        <tbody>
          {m.shown.map((id) => {
            const pairs = items.flatMap((it) => {
              const a = per(id, it.id),
                b = per(lead, it.id);

              return a !== undefined && b !== undefined ? [[a, b] as const] : [];
            });

            const wins = pairs.filter(([a, b]) => compareBy(metric, a, b) < 0).length;
            const ties = pairs.filter(([a, b]) => a === b).length;

            return (
              <tr key={id} style={colorVars(m.contestant(id))} data-kind={m.contestant(id)?.kind}>
                <th scope="row">
                  <span className="swatch" aria-hidden="true" />
                  {m.nameOf(id)}
                </th>
                {items.map((it) => {
                  const v = per(id, it.id);

                  const best =
                    v !== undefined &&
                    m.shown.every((o) => {
                      const w = per(o, it.id);

                      return w === undefined || compareBy(metric, v, w) <= 0;
                    });

                  return (
                    <td key={it.id} data-best={best}>
                      {v === undefined ? "·" : formatNumber(metric, v)}
                    </td>
                  );
                })}
                {lead && (
                  <td className="muted">
                    {id === lead
                      ? "—"
                      : `better on ${wins} of ${pairs.length}${ties ? `, tied on ${ties}` : ""}`}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

// ---------------------------------------------------------------- calibration
type Bin = { conf: number; agree: number; count: number };

export function Calibration({ model: m }: { model: CardModel }) {
  const [bins, setBins] = useState<Record<string, Bin[]> | null>(null);
  const { targets: targetsPath, preds } = m.card.chunks;
  const lineup = m.shown.join(",");
  const { wf, qt } = m.view;

  useEffect(() => {
    if (!targetsPath || !preds) return;
    let alive = true;

    (async () => {
      const targets = await loadChunk(targetsPath, targetsSchema);
      const out: Record<string, Bin[]> = {};

      for (const id of lineup.split(",").filter(Boolean)) {
        const path = preds[id];

        if (!path) continue;
        const p = await loadChunk(path, predsSchema);

        const answers = targets.rows.flatMap((r, i) =>
          (!wf || r.wf === wf || r.split === wf) && (!qt || r.type === qt)
            ? [{ prediction: p.p[i], reference: r.target }]
            : [],
        );

        out[id] = score(answers).reliability.map((b) => ({
          conf: b.confidence,
          agree: b.agreement,
          count: b.count,
        }));
      }

      if (alive) setBins(out);
    })();

    return () => {
      alive = false;
    };
  }, [lineup, wf, qt, targetsPath, preds]);

  if (!bins) return <p className="muted">Loading predictions…</p>;
  const S = 150;

  return (
    <div className="calibration">
      {m.shown.map((id) => {
        // One-hot answers (keyword rules, say) state no graded confidence: every dot sits at 100%.
        const graded = bins[id]?.some((b) => b.conf < 0.95) ?? false;

        return (
          <figure key={id} style={colorVars(m.contestant(id))} data-kind={m.contestant(id)?.kind}>
            <svg
              viewBox={`-26 -8 ${S + 34} ${S + 30}`}
              role="img"
              aria-label={`${m.nameOf(id)}: agreement by stated confidence. Dots on the diagonal are well calibrated.`}
            >
              <rect className="frame" x={0} y={0} width={S} height={S} />
              <line className="diag" x1={0} y1={S} x2={S} y2={0} />
              {[0, 0.5, 1].map((t) => (
                <g key={t} className="tick">
                  <text x={t * S} y={S + 14} textAnchor="middle">
                    {t * 100}%
                  </text>
                  <text x={-6} y={S - t * S + 4} textAnchor="end">
                    {t * 100}%
                  </text>
                </g>
              ))}
              {bins[id]?.map((b) => (
                <circle
                  key={b.conf}
                  cx={b.conf * S}
                  cy={S - b.agree * S}
                  r={Math.max(2.5, Math.sqrt(b.count) / 2.2)}
                />
              ))}
            </svg>
            <figcaption>
              <span className="swatch" aria-hidden="true" />
              {m.label(id)}
            </figcaption>
            {!graded && <p className="muted small">States no graded confidence.</p>}
          </figure>
        );
      })}
    </div>
  );
}
