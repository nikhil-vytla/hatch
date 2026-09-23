import { useEffect, useMemo, useRef, useState } from "react";
import type { Card, CardContestant, Estimate, MetricDef } from "../../../packages/arena/src/data/schema";
import { score } from "../../../packages/arena/src/score";
import { getApiKey } from "../api";
import { BoardLens, LIVE_ID } from "./board";
import { defaults, formatValue, loadChunk, writeView, type View } from "./data";

const MAX_CONTESTANTS = 6;
const LENS_LABEL: Record<string, string> = { bars: "Bars", scatter: "Trade-off", "per-item": "Per seed", table: "Table", reliability: "Calibration", board: "Watch", case: "Case" };
const KIND_LABEL: Record<string, string> = { hosted: "Hosted", local: "Local", code: "Code" };
const better = (m: MetricDef, a: number, b: number) => (m.better === "higher" ? b - a : a - b);
const spread = (m: MetricDef, e?: Estimate) => (e?.lo != null && e?.hi != null ? `±${formatValue(m.unit, (e.hi - e.lo) / 2).replace(/^([\d.]+)%$/, "$1")}${m.unit === "%" ? "pp" : ""}` : "");

// ---------------------------------------------------------------- picker
function Picker({ card, selected, onChange, colorOf }: { card: Card; selected: string[]; onChange: (ids: string[]) => void; colorOf: (id: string) => string }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, [open]);
  const pool: CardContestant[] = [...card.contestants, ...(card.family === "game" && getApiKey() ? [{ id: LIVE_ID, name: "Jev · live (your key)", short: "Jev live", kind: "hosted" as const, color: "#0b8a55", default: false, runSets: [], policy: "judge each spot, remembering confident judgements; plays on the board only" }] : [])];
  const byId = new Map(pool.map((c) => [c.id, c]));
  const matches = pool.filter((c) => !selected.includes(c.id) && `${c.name} ${c.policy ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="arena-chips" ref={ref}>
      {selected.map((id) => { const c = byId.get(id); return c ? (
        <span key={id} className="arena-chip" title={c.policy}>
          <span className="arena-dot" style={{ background: colorOf(id) }} />{c.name}
          <button aria-label={`Remove ${c.name}`} onClick={() => onChange(selected.filter((x) => x !== id))} disabled={selected.length <= 1}>×</button>
        </span>) : null; })}
      <button className="arena-add" onClick={() => setOpen((o) => !o)} disabled={selected.length >= MAX_CONTESTANTS} aria-expanded={open}>+ Add <span className="arena-muted">{selected.length} of {Math.min(MAX_CONTESTANTS, pool.length)}</span></button>
      {open && (
        <div className="arena-popover" role="dialog" aria-label="Add a contestant">
          <input autoFocus placeholder="Search contestants" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }} />
          {(["hosted", "local", "code"] as const).map((k) => { const list = matches.filter((c) => c.kind === k); return list.length ? (
            <div key={k}><p className="arena-group">{KIND_LABEL[k]}</p>
              {list.map((c) => <button key={c.id} className="arena-option" onClick={() => { onChange([...selected, c.id]); setOpen(false); setQuery(""); }}><span className="arena-dot" style={{ background: c.color }} /><span><b>{c.name}</b>{c.policy && <small>{c.policy}</small>}</span></button>)}
            </div>) : null; })}
          {!matches.length && <p className="arena-muted">Everything is already on the card.</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- lenses
function Bars({ card, metric, ids, results, colorOf, focus, setFocus }: LensProps) {
  const rows = ids.map((id) => ({ id, e: results[id]?.[metric.id] })).filter((r) => r.e).sort((a, b) => better(metric, a.e!.value, b.e!.value));
  const max = metric.unit === "%" ? 1 : Math.max(...rows.map((r) => Math.max(r.e!.hi ?? r.e!.value, ...(r.e!.perItem?.map((p) => p.value) ?? [0])))) || 1;
  const x = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const hovered = rows.find((r) => r.id === focus)?.e;
  return (
    <div className="arena-bars-lens" onMouseLeave={() => setFocus(null)}>
      {hovered?.lo != null && <div className="arena-band" style={{ left: `calc(var(--label) + (100% - var(--label) - var(--value)) * ${(hovered.lo / max)})`, width: `calc((100% - var(--label) - var(--value)) * ${((hovered.hi! - hovered.lo!) / max)})` }} />}
      {rows.map(({ id, e }) => { const c = card.contestants.find((x) => x.id === id); return (
        <div key={id} className={`arena-bar-row ${focus && focus !== id ? "faded" : ""}`} onMouseEnter={() => setFocus(id)}>
          <span className="arena-bar-name"><span className="arena-dot" style={{ background: colorOf(id) }} />{c?.name ?? id}{e!.coverage && <small> · {e!.coverage.covered} of {e!.coverage.of} seeds</small>}</span>
          <span className="arena-track">
            <span className="arena-fill" style={{ width: x(e!.value), background: colorOf(id) }} />
            {e!.lo != null && <span className="arena-whisker" style={{ left: x(e!.lo), width: `calc(${x(e!.hi!)} - ${x(e!.lo)})` }} />}
            {e!.perItem?.map((p) => <span key={p.item} className="arena-seed-dot" style={{ left: x(p.value), borderColor: colorOf(id) }} title={`Seed ${p.item}: ${formatValue(metric.unit, p.value)}`} />)}
          </span>
          <span className="arena-bar-value">{formatValue(metric.unit, e!.value)}<small>{spread(metric, e) || (e!.perItem ? ` mean of ${e!.perItem.length}` : "")}</small></span>
        </div>); })}
    </div>
  );
}

function pareto(points: { id: string; x: number; y: number }[], mx: MetricDef, my: MetricDef) {
  const good = (a: typeof points[number], b: typeof points[number]) => (mx.better === "higher" ? a.x >= b.x : a.x <= b.x) && (my.better === "higher" ? a.y >= b.y : a.y <= b.y) && (a.x !== b.x || a.y !== b.y);
  return points.filter((p) => !points.some((q) => good(q, p))).sort((a, b) => a.x - b.x);
}
function Scatter({ card, ids, results, colorOf, focus, setFocus, xMetric, yMetric }: LensProps & { xMetric: MetricDef; yMetric: MetricDef }) {
  const pts = ids.map((id) => ({ id, x: results[id]?.[xMetric.id]?.value, y: results[id]?.[yMetric.id]?.value })).filter((p) => p.x != null && p.y != null && !Number.isNaN(p.x) && !Number.isNaN(p.y)) as { id: string; x: number; y: number }[];
  if (pts.length < 2) return <p className="arena-muted">Add at least two contestants with both measurements.</p>;
  const W = 760, H = 320, P = 48;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)], [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const pad = (a: number, b: number) => (b - a || Math.abs(a) || 1) * 0.12;
  const sx = (v: number) => P + ((v - (x0 - pad(x0, x1))) / (x1 - x0 + 2 * pad(x0, x1))) * (W - 2 * P);
  const sy = (v: number) => H - P - ((v - (y0 - pad(y0, y1))) / (y1 - y0 + 2 * pad(y0, y1))) * (H - 2 * P);
  const front = pareto(pts, xMetric, yMetric);
  const name = (id: string) => card.contestants.find((c) => c.id === id)?.short ?? id;
  return (
    <svg className="arena-scatter" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${yMetric.label} against ${xMetric.label}`} onMouseLeave={() => setFocus(null)}>
      <line x1={P} y1={H - P} x2={W - P} y2={H - P} className="axis" /><line x1={P} y1={P / 2} x2={P} y2={H - P} className="axis" />
      <text x={W - P} y={H - 12} textAnchor="end" className="axis-label">{xMetric.label} · {xMetric.better === "higher" ? "higher" : "lower"} is better →</text>
      <text x={12} y={P / 2 - 6} className="axis-label">{yMetric.label} · {yMetric.better} is better</text>
      {front.length > 1 && <polyline className="frontier" points={front.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")} />}
      {pts.map((p) => { const on = front.some((f) => f.id === p.id); return (
        <g key={p.id} className={focus && focus !== p.id ? "faded" : ""} onMouseEnter={() => setFocus(p.id)}>
          <circle cx={sx(p.x)} cy={sy(p.y)} r={on ? 7 : 5.5} fill={colorOf(p.id)} opacity={on ? 1 : 0.55} />
          {(() => { const left = sx(p.x) > W * 0.62; return <text x={sx(p.x) + (left ? -10 : 10)} y={sy(p.y) + 4} textAnchor={left ? "end" : "start"} className="point-label">{name(p.id)} <tspan className="point-value">{formatValue(xMetric.unit, p.x)}, {formatValue(yMetric.unit, p.y)}</tspan></text>; })()}
        </g>); })}
    </svg>
  );
}

function PerItem({ card, metric, ids, results, colorOf }: LensProps) {
  const items = card.items ?? [];
  const lead = ids[0], lr = results[lead]?.[metric.id]?.perItem ?? [];
  return (
    <div className="arena-peritem">
      <table>
        <thead><tr><th>{metric.label}</th>{items.map((it) => <th key={it.id}>{it.label}</th>)}<th>vs {card.contestants.find((c) => c.id === lead)?.short}</th></tr></thead>
        <tbody>{ids.map((id) => { const per = results[id]?.[metric.id]?.perItem ?? []; const pairs = per.map((p) => [p.value, lr.find((q) => q.item === p.item)?.value] as const).filter(([, b]) => b != null);
          const wins = pairs.filter(([a, b]) => better(metric, a, b!) < 0).length, ties = pairs.filter(([a, b]) => a === b).length;
          return (<tr key={id}><th><span className="arena-dot" style={{ background: colorOf(id) }} />{card.contestants.find((c) => c.id === id)?.name ?? id}</th>
            {items.map((it) => { const v = per.find((p) => p.item === it.id)?.value; const best = v != null && ids.every((o) => { const w = results[o]?.[metric.id]?.perItem?.find((p) => p.item === it.id)?.value; return w == null || better(metric, v, w) <= 0; }); return <td key={it.id} className={best ? "best" : ""}>{v == null ? "·" : formatValue(metric.unit, v)}</td>; })}
            <td className="arena-muted">{id === lead ? "—" : `better on ${wins} of ${pairs.length}${ties ? `, tied ${ties}` : ""}`}</td></tr>); })}</tbody>
      </table>
    </div>
  );
}

function Table({ card, ids, results, colorOf }: LensProps) {
  const [sort, setSort] = useState(card.primary);
  const m = card.metrics.find((x) => x.id === sort)!;
  const rows = [...ids].sort((a, b) => better(m, results[a]?.[sort]?.value ?? NaN, results[b]?.[sort]?.value ?? NaN) || 0);
  return (
    <table className="arena-table">
      <thead><tr><th>Contestant</th>{card.metrics.map((mm) => <th key={mm.id}><button onClick={() => setSort(mm.id)} aria-pressed={sort === mm.id} title={mm.help}>{mm.label}{sort === mm.id ? (mm.better === "higher" ? " ↓" : " ↑") : ""}</button></th>)}</tr></thead>
      <tbody>{rows.map((id) => <tr key={id}><th><span className="arena-dot" style={{ background: colorOf(id) }} />{card.contestants.find((c) => c.id === id)?.name ?? id}</th>
        {card.metrics.map((mm) => { const e = results[id]?.[mm.id]; return <td key={mm.id}>{formatValue(mm.unit, e?.value)}<small>{spread(mm, e)}</small></td>; })}</tr>)}</tbody>
    </table>
  );
}

function Reliability({ card, ids, colorOf, slice }: LensProps & { slice: (row: any) => boolean }) {
  const [data, setData] = useState<Record<string, { lo: number; conf: number; agree: number; count: number }[]> | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const targets = await loadChunk(card.chunks.targets!);
      const out: typeof data = {};
      for (const id of ids) { const preds = await loadChunk(card.chunks.preds![id]); const rows = targets.rows.map((r: any, i: number) => ({ r, p: preds.p[i] })).filter(({ r }: any) => slice(r)); out[id] = score(rows.map(({ r, p }: any) => ({ prediction: p, reference: r.target }))).reliability.map((b) => ({ lo: b.lo, conf: b.confidence, agree: b.agreement, count: b.count })); }
      if (alive) setData(out);
    })();
    return () => { alive = false; };
  }, [ids.join(","), slice]);
  if (!data) return <p className="arena-muted">Loading predictions…</p>;
  const S = 150;
  return (
    <div className="arena-reliability-grid">
      {ids.map((id) => (
        <figure key={id}>
          <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`Agreement by stated confidence for ${id}; the diagonal is perfect calibration`}>
            <rect x="0" y="0" width={S} height={S} className="frame" /><line x1="0" y1={S} x2={S} y2="0" className="diag" />
            {data[id]?.map((b) => <circle key={b.lo} cx={b.conf * S} cy={S - b.agree * S} r={Math.max(2.5, Math.sqrt(b.count) / 2.2)} fill={colorOf(id)} opacity=".8" />)}
          </svg>
          <figcaption><span className="arena-dot" style={{ background: colorOf(id) }} />{card.contestants.find((c) => c.id === id)?.short}</figcaption>
        </figure>
      ))}
      <p className="arena-muted">Each dot is a confidence bin, sized by how many decisions fall in it. Dots on the diagonal mean stated confidence matches how often the top answer agrees with the reference.</p>
    </div>
  );
}

function CaseLens({ card, ids, colorOf, wf }: LensProps & { wf?: string }) {
  const [state, setState] = useState<{ cases: any; targets: any; preds: Record<string, any> } | null>(null);
  const [i, setI] = useState(0);
  useEffect(() => { let alive = true; (async () => { const [cases, targets] = await Promise.all([loadChunk(card.chunks.cases!), loadChunk(card.chunks.targets!)]); const preds: Record<string, any> = {}; for (const id of ids) preds[id] = await loadChunk(card.chunks.preds![id]); if (alive) setState({ cases, targets, preds }); })(); return () => { alive = false; }; }, [ids.join(",")]);
  if (!state) return <p className="arena-muted">Loading cases…</p>;
  const list = state.cases.cases.map((c: any, ci: number) => ({ c, ci })).filter(({ c }: any) => !wf || c.workflow === wf);
  const { c, ci } = list[((i % list.length) + list.length) % list.length];
  const rows = state.targets.rows.map((r: any, idx: number) => ({ r, idx })).filter(({ r }: any) => r.c === ci);
  const top = (p: number[]) => p.indexOf(Math.max(...p));
  return (
    <div className="arena-case">
      <div className="arena-case-head"><h3>{c.id.replaceAll("_", " ")}</h3><button onClick={() => setI(i - 1)}>Previous</button><button onClick={() => setI(i + 1)}>Next</button><button onClick={() => setI(Math.floor(Math.random() * list.length))}>Random</button></div>
      <details><summary>State every model saw</summary><pre>{JSON.stringify(c.state, null, 2)}</pre></details>
      {rows.map(({ r, idx }: any) => { const q = c.questions.find((x: any) => x.key === r.key); return (
        <div key={r.key} className="arena-question">
          <p><b>{q.instructions}</b> <span className="arena-muted">{r.type}</span></p>
          <div className="arena-answer-row">
            <figure><Mini values={r.target} highlight={top(r.target)} color="var(--ink)" /><figcaption>Reference<br /><span>{r.keys[top(r.target)].replaceAll("_", " ")}</span></figcaption></figure>
            {ids.map((id) => { const p = state.preds[id].p[idx], t = top(p), wrong = t !== top(r.target) && p[t] >= 0.7; return (
              <figure key={id} className={wrong ? "wrong" : ""}><Mini values={p} highlight={t} color={colorOf(id)} /><figcaption>{card.contestants.find((x) => x.id === id)?.short}<br /><span>{r.keys[t].replaceAll("_", " ")} · {Math.round(p[t] * 100)}%{wrong ? " · confident, disagrees" : ""}</span></figcaption></figure>); })}
          </div>
        </div>); })}
    </div>
  );
}
function Mini({ values, highlight, color }: { values: number[]; highlight: number; color: string }) {
  const sum = values.reduce((a, b) => a + b, 0) || 1;
  return <div className="arena-mini">{values.map((v, k) => <div key={k}><span style={{ height: `${Math.max(3, (v / sum) * 100)}%`, background: k === highlight ? color : undefined }} /></div>)}</div>;
}

type LensProps = { card: Card; metric: MetricDef; ids: string[]; results: Card["results"]; colorOf: (id: string) => string; focus: string | null; setFocus: (id: string | null) => void };

// ---------------------------------------------------------------- the card
/** Everything a card view needs, derived from the card data and the URL. Variants share it. */
export function useCardModel(card: Card, view: View) {
  const pool = new Set(card.contestants.map((c) => c.id).concat(LIVE_ID));
  const requested = view.c?.filter((id) => pool.has(id));
  const dropped = (view.c ?? []).filter((id) => !pool.has(id));
  const ids = requested?.length ? requested : defaults(card, view.g ?? card.protocolGroups.at(-1)?.hash);
  const lens = view.lens && card.lenses.includes(view.lens as any) ? view.lens : card.lenses[0];
  const metric = card.metrics.find((m) => m.id === view.m) ?? card.metrics.find((m) => m.id === card.primary)!;
  const [focus, setFocus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const colorOf = (id: string) => card.contestants.find((c) => c.id === id)?.color ?? "#0b8a55";
  const nameOf = (id: string, short = false) => { const c = card.contestants.find((x) => x.id === id); return (short ? c?.short : c?.name) ?? (id === LIVE_ID ? "Jev live" : id); };
  const set = (patch: Partial<View>, replace = false) => writeView({ ...view, card: card.id, ...patch }, replace);
  // Slices (judgement sets): workflow and question type.
  const results = useMemo(() => {
    const wf = view.wf && card.slices?.workflow?.[view.wf], qt = view.qt && card.slices?.type?.[view.qt];
    return (wf || qt || card.results) as Card["results"];
  }, [card, view.wf, view.qt]);
  const resultIds = ids.filter((id) => results[id]);
  const scatterAxes = card.id === "typed-decisions" ? ["ece", "agreement"] : card.id === "tetris-realtime" ? ["gameTime", "lines"] : card.id === "spot-robustness" ? ["meanChange", "sameChoice"] : ["decisionMs", "lines"];
  const axes = card.id === "cafe" ? ["violation", "exact"] : scatterAxes;
  // Fall back to the first two metrics when a card lacks the preferred axes.
  const [xM, yM] = axes.map((id, k) => card.metrics.find((m) => m.id === id) ?? card.metrics[Math.min(k, card.metrics.length - 1)]);
  // Winner tiles rank models; code players are references. Ties name everyone tied.
  const models = resultIds.filter((id) => card.contestants.find((c) => c.id === id)?.kind !== "code");
  const tilePool = models.length ? models : resultIds;
  const tiles = card.family === "robustness" ? [] : card.metrics.slice(0, 4).map((m) => {
    const ranked = tilePool.filter((id) => results[id]?.[m.id] && !Number.isNaN(results[id][m.id].value)).sort((a, b) => better(m, results[a][m.id].value, results[b][m.id].value));
    if (!ranked.length) return null;
    const top = results[ranked[0]][m.id].value, tied = ranked.filter((id) => results[id][m.id].value === top);
    return { m, ids: tied, e: results[ranked[0]][m.id] };
  }).filter(Boolean) as { m: MetricDef; ids: string[]; e: Estimate }[];
  const groupsInView = new Set(ids.flatMap((id) => card.contestants.find((c) => c.id === id)?.runSets ?? []).map((rs) => card.protocolGroups.find((g) => g.runSets.includes(rs))?.hash).filter(Boolean));
  const slice = useMemo(() => (r: any) => (!view.wf || r.wf === view.wf) && (!view.qt || r.type === view.qt), [view.wf, view.qt]);
  const copy = async () => { await navigator.clipboard?.writeText(`${location.href.replace(/#.*/, "")}#/arena/${card.id}?c=${ids.join(",")}&lens=${lens}&m=${metric.id}${view.wf ? `&wf=${view.wf}` : ""}${view.qt ? `&qt=${view.qt}` : ""}${view.seed ? `&seed=${view.seed}` : ""}`).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return { card, view, ids, dropped, lens, metric, results, resultIds, xM, yM, models, tiles, groupsInView, slice, set, colorOf, nameOf, focus, setFocus, copy, copied };
}
export type CardModel = ReturnType<typeof useCardModel>;
export const KIND = (card: Card) => card.family === "game" ? "Game" : card.family === "robustness" ? "Robustness" : "Judgement set";
export const REFERENCE = (card: Card) => card.reference === "world-outcome" ? "measured in the world" : card.reference === "soft-teacher" ? "agreement with a soft reference" : card.reference === "authored-labels" ? "agreement with authored expectations" : "self-consistency";
export { better, spread, LENS_LABEL };

export function Tiles({ model: m }: { model: CardModel }) {
  if (!m.tiles.length) return null;
  return <>
    <div className="arena-tiles">{m.tiles.map(({ m: metric, ids: winners, e }) => (
      <div key={metric.id} className="arena-tile" title={metric.help}><p>{metric.better === "higher" ? "Most" : "Least"} · {metric.label.toLowerCase()}</p>
        <b>{winners.length > 2 ? <>Tie · {winners.length} models</> : winners.map((id, k) => <span key={id} className="arena-tile-name">{k > 0 && <span className="arena-muted"> & </span>}<span className="arena-dot" style={{ background: m.colorOf(id) }} />{m.nameOf(id, true)}</span>)}</b>
        <span>{formatValue(metric.unit, e.value)}</span></div>))}</div>
    {m.models.length > 0 && m.models.length < m.resultIds.length && <p className="arena-muted arena-tiles-note">Best among the models on this card. Code players are references and appear in every view.</p>}
  </>;
}
export function Contestants({ model: m }: { model: CardModel }) {
  return <>
    <Picker card={m.card} selected={m.ids} onChange={(c) => m.set({ c })} colorOf={m.colorOf} />
    {m.dropped.length > 0 && <p className="arena-notice">Not on this card: {m.dropped.join(", ")}.</p>}
    {m.groupsInView.size > 1 && <p className="arena-notice">These contestants were recorded under {m.groupsInView.size} different protocols ({m.card.protocolGroups.filter((g) => m.groupsInView.has(g.hash)).map((g) => g.label).join("; ")}). Compare with care.</p>}
  </>;
}
export function Toolbar({ model: m }: { model: CardModel }) {
  const { card, view, lens, metric, set } = m;
  return <>
    <div className="arena-toolbar">
      <div className="arena-tabs" role="tablist">{card.lenses.map((l) => <button key={l} role="tab" aria-selected={l === lens} onClick={() => set({ lens: l })}>{LENS_LABEL[l]}</button>)}</div>
      {["bars", "per-item"].includes(lens) && <label>Metric <select value={metric.id} onChange={(e) => set({ m: e.target.value })}>{card.metrics.map((mm) => <option key={mm.id} value={mm.id}>{mm.label}</option>)}</select></label>}
      {card.slices && ["bars", "scatter", "table", "reliability", "case"].includes(lens) && <>
        <label>{card.facetLabels?.workflow ?? "Workflow"} <select value={view.wf ?? ""} onChange={(e) => set({ wf: e.target.value || undefined, qt: undefined })}><option value="">All</option>{Object.keys(card.slices.workflow ?? {}).map((w) => <option key={w} value={w}>{w.replaceAll("_", " ")}</option>)}</select></label>
        {lens !== "case" && Object.keys(card.slices.type ?? {}).length > 0 && <label>{card.facetLabels?.type ?? "Question type"} <select value={view.qt ?? ""} onChange={(e) => set({ qt: e.target.value || undefined, wf: undefined })}><option value="">All</option>{Object.keys(card.slices.type ?? {}).map((t) => <option key={t} value={t}>{t}</option>)}</select></label>}
      </>}
    </div>
    {["bars", "per-item"].includes(lens) && <p className="arena-subtitle">{metric.help} <b>{metric.better === "higher" ? "Higher" : "Lower"} is better.</b></p>}
  </>;
}
export function LensView({ model: m }: { model: CardModel }) {
  const p = { card: m.card, metric: m.metric, ids: m.resultIds, results: m.results, colorOf: m.colorOf, focus: m.focus, setFocus: m.setFocus };
  return (
    <div className="arena-lens">
      {m.lens === "bars" && <Bars {...p} />}
      {m.lens === "scatter" && <Scatter {...p} xMetric={m.xM} yMetric={m.yM} />}
      {m.lens === "per-item" && <PerItem {...p} />}
      {m.lens === "table" && <Table {...p} />}
      {m.lens === "reliability" && <Reliability {...p} slice={m.slice} />}
      {m.lens === "case" && <CaseLens {...p} wf={m.view.wf} />}
      {m.lens === "board" && <BoardLens card={m.card} selected={m.ids} colorOf={m.colorOf} seed={m.view.seed ?? m.card.items?.[0]?.id ?? "7"} onSeed={(seed) => m.set({ seed })} />}
    </div>
  );
}

export function BenchmarkCard({ card, view }: { card: Card; view: View }) {
  const m = useCardModel(card, view);
  return (
    <article className="arena-card" aria-labelledby={`card-${card.id}`}>
      <header className="arena-card-head">
        <p className="arena-kicker">{KIND(card)} · {REFERENCE(card)}</p>
        <h2 id={`card-${card.id}`}>{card.title}</h2>
        <p className="arena-question-line">{card.question}</p>
        <button className="arena-link" onClick={m.copy}>{m.copied ? "Link copied" : "Copy link"}</button>
      </header>
      <Tiles model={m} />
      <Contestants model={m} />
      <Toolbar model={m} />
      <LensView model={m} />
      <footer className="arena-provenance">{card.provenance}</footer>
    </article>
  );
}

/** Compact overview card: title, a small bar chart of the default lineup, one provenance line. */
export function MiniCard({ card }: { card: Card }) {
  const metric = card.metrics.find((m) => m.id === card.primary)!;
  const ids = defaults(card, card.protocolGroups.at(-1)?.hash).filter((id) => card.results[id]?.[metric.id]);
  const rows = ids.map((id) => ({ id, e: card.results[id][metric.id] })).sort((a, b) => better(metric, a.e.value, b.e.value));
  const max = metric.unit === "%" ? 1 : Math.max(...rows.map((r) => r.e.value)) || 1;
  return (
    <a className="arena-mini-card" href={`#/arena/${card.id}`}>
      <p className="arena-kicker">{card.family === "game" ? "Game" : card.family === "robustness" ? "Robustness" : "Judgement set"}</p>
      <h3>{card.title}</h3>
      <p className="arena-mini-metric">{metric.label} · {metric.better} is better</p>
      <div className="arena-mini-bars">{rows.map(({ id, e }) => { const c = card.contestants.find((x) => x.id === id)!; return (
        <div key={id}><span>{c.short}</span><span className="arena-track"><span className="arena-fill" style={{ width: `${(e.value / max) * 100}%`, background: c.color }} /></span><b>{formatValue(metric.unit, e.value)}</b></div>); })}</div>
      <p className="arena-provenance">{card.provenance}</p>
    </a>
  );
}
