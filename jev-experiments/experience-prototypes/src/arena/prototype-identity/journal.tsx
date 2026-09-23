/** PROTOTYPE variant C, "Field journal": editorial. A visual table of contents; each card is an article figure with margin notes. */
import type { ArenaIndex, Card } from "../../../../packages/arena/src/data/schema";
import { Contestants, LensView, LENS_LABEL, useCardModel } from "../card";
import { formatValue, type View } from "../data";
import { cardHref, standings } from "./shared";

function Sketch({ card }: { card: Card }) {
  const s = standings(card), max = s.metric.unit === "%" ? 1 : Math.max(...s.rows.map((r) => r.e.value)) || 1;
  return (
    <svg viewBox="0 0 160 90" className="fj-sketch" aria-hidden="true">
      <rect x="0.5" y="0.5" width="159" height="89" className="fj-sketch-frame" />
      {s.rows.slice(0, 5).map((r, i) => <g key={r.id}><rect x="10" y={10 + i * 15} width={Math.max(3, (r.e.value / max) * 130)} height="9" fill={i === 0 ? "var(--fj-accent)" : "var(--fj-box)"} stroke="var(--fj-ink)" strokeWidth=".8" /></g>)}
    </svg>
  );
}

export function JournalOverview({ index, view }: { index: ArenaIndex; view: View }) {
  return (
    <div className="fj">
      <header className="fj-masthead">
        <p className="fj-smallcaps">Jev experiments · field journal · {new Date(index.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</p>
        <h1>Notes on typed decisions, measured side by side</h1>
        <p className="fj-lede">Each entry puts the same situation to several decision-makers and records what happened. The figures are live: add or remove contestants, change the measure, or open the games.</p>
      </header>
      <ol className="fj-toc">{index.cards.map((card, i) => { const s = standings(card); return (
        <li key={card.id}><a href={cardHref(card, view)}>
          <Sketch card={card} />
          <div><p className="fj-smallcaps">Fig. {i + 1} · {card.family}</p><h2>{card.title}</h2><p>{s.finding}</p></div>
        </a></li>); })}</ol>
    </div>
  );
}

export function JournalCard({ card, view }: { card: Card; view: View }) {
  const m = useCardModel(card, view);
  const s = standings(card);
  return (
    <div className="fj fj-article">
      <nav className="fj-smallcaps"><a href={`#/arena${view.v ? `?v=${view.v}` : ""}`}>Contents</a></nav>
      <div className="fj-columns">
        <main>
          <p className="fj-smallcaps">{card.family} · {card.reference.replace("-", " ")}</p>
          <h1>{card.title}</h1>
          <p className="fj-lede">{card.question} {s.finding}</p>
          <figure className="fj-figure">
            <div className="fj-figure-tabs" role="tablist">{card.lenses.map((l) => <button key={l} role="tab" aria-selected={l === m.lens} onClick={() => m.set({ lens: l })}>{LENS_LABEL[l]}</button>)}</div>
            <LensView model={m} />
            <figcaption><b>Figure 1.</b> {m.lens === "scatter" ? `${m.yM.label} against ${m.xM.label.toLowerCase()}; the dashed line joins contestants no one beats on both.` : `${m.metric.label}. ${m.metric.help}`}</figcaption>
          </figure>
        </main>
        <aside className="fj-margin">
          <section><p className="fj-smallcaps">In this figure</p><Contestants model={m} /></section>
          {["bars", "per-item"].includes(m.lens) && <section><p className="fj-smallcaps">Measure</p><select value={m.metric.id} onChange={(e) => m.set({ m: e.target.value })}>{card.metrics.map((mm) => <option key={mm.id} value={mm.id}>{mm.label}</option>)}</select><p>{m.metric.better === "higher" ? "Higher" : "Lower"} is better.</p></section>}
          {m.tiles.length > 0 && <section><p className="fj-smallcaps">Key numbers</p><ul>{m.tiles.map(({ m: metric, ids, e }) => <li key={metric.id}><span>{metric.label}</span> <b>{formatValue(metric.unit, e.value)}</b> · {ids.map((id) => m.nameOf(id, true)).join(" & ")}</li>)}</ul></section>}
          <section><p className="fj-smallcaps">How we know</p><p>{card.provenance}</p></section>
          <button className="fj-link" onClick={m.copy}>{m.copied ? "Link copied" : "Cite this view"}</button>
        </aside>
      </div>
    </div>
  );
}
