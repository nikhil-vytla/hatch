/** PROTOTYPE variant A, "Instrument": a dark, numbers-first readout. Index table, big figures, dense grid. */
import type { ArenaIndex, Card } from "../../../../packages/arena/src/data/schema";
import { Contestants, LensView, LENS_LABEL, useCardModel, better, spread } from "../card";
import { formatValue, type View } from "../data";
import { cardHref, standings } from "./shared";

export function InstrumentOverview({ index, view }: { index: ArenaIndex; view: View }) {
  const study = index.cards.find((c) => c.id === "typed-decisions"),
    turns = index.cards.find((c) => c.id === "tetris-turns"),
    rt = index.cards.find((c) => c.id === "tetris-realtime");

  const stat = (card: Card | undefined, id: string, metric: string) => card?.results[id]?.[metric];

  const strip = [
    {
      k: "Agreement",
      v: formatValue("%", stat(study, "jev", "agreement")?.value),
      s: "Jev · 400 cases",
    },
    {
      k: "Calibration error",
      v: formatValue("", stat(study, "jev", "ece")?.value),
      s: "Jev · lower is better",
    },
    {
      k: "Lines per 40 pieces",
      v: formatValue("lines", stat(turns, "jev.spot-clean", "lines")?.value),
      s: "judge each spot · 7 seeds",
    },
    {
      k: "Real-time game",
      v: formatValue("s", stat(rt, "jev.spot-clean-confident@backoff", "gameTime")?.value),
      s: "confident memory · 40 pieces",
    },
  ];

  return (
    <div className="ins">
      <header className="ins-hero">
        <p className="ins-code">
          JEV / ARENA / {new Date(index.generatedAt).toISOString().slice(0, 10)}
        </p>
        <h1>
          Typed decisions,
          <br />
          measured.
        </h1>
        <div className="ins-strip">
          {strip.map((x) => (
            <div key={x.k}>
              <p>{x.k}</p>
              <b>{x.v}</b>
              <span>{x.s}</span>
            </div>
          ))}
        </div>
      </header>
      <table className="ins-index">
        <thead>
          <tr>
            <th>#</th>
            <th>Benchmark</th>
            <th>Metric</th>
            <th>Leader</th>
            <th></th>
            <th>Field</th>
            <th>Items</th>
          </tr>
        </thead>
        <tbody>
          {index.cards.map((card, i) => {
            const s = standings(card);
            const max = s.metric.unit === "%" ? 1 : Math.max(...s.rows.map((r) => r.e.value)) || 1;

            return (
              <tr
                key={card.id}
                onClick={() => {
                  location.hash = cardHref(card, view);
                }}
              >
                <td className="ins-code">T-{String(i + 1).padStart(2, "0")}</td>
                <td>
                  <a href={cardHref(card, view)}>{card.title}</a>
                  <small>{card.family}</small>
                </td>
                <td className="ins-dim">
                  {s.metric.label}
                  <small>{s.metric.better} is better</small>
                </td>
                <td>
                  <span className="ins-sw" style={{ background: s.lead?.c.color }} />
                  {s.lead?.c.short}
                </td>
                <td className="ins-big">
                  {s.lead ? formatValue(s.metric.unit, s.lead.e.value) : "—"}
                </td>
                <td>
                  <div className="ins-spark">
                    {s.rows.map((r) => (
                      <span
                        key={r.id}
                        title={`${r.c.short} ${formatValue(s.metric.unit, r.e.value)}`}
                        style={{
                          height: `${Math.max(6, (r.e.value / max) * 100)}%`,
                          background: r.c.color,
                        }}
                      />
                    ))}
                  </div>
                </td>
                <td className="ins-dim">{s.lead?.e.n ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function InstrumentCard({ card, view }: { card: Card; view: View }) {
  const m = useCardModel(card, view);

  const ranked = [...m.resultIds].sort((a, b) =>
    better(
      m.metric,
      m.results[a][m.metric.id]?.value ?? NaN,
      m.results[b][m.metric.id]?.value ?? NaN,
    ),
  );

  const lead = ranked[0];

  return (
    <div className="ins ins-card">
      <nav className="ins-code">
        <a href={`#/arena${view.v ? `?v=${view.v}` : ""}`}>ARENA</a> / {card.id.toUpperCase()}{" "}
        <button className="ins-btn" onClick={m.copy}>
          {m.copied ? "COPIED" : "COPY LINK"}
        </button>
      </nav>
      <div className="ins-split">
        <aside>
          <p className="ins-code">
            {card.family.toUpperCase()} · {card.reference.toUpperCase()}
          </p>
          <h1>{card.title}</h1>
          <p className="ins-dim">{card.question}</p>
          {lead && (
            <div className="ins-readout">
              <p className="ins-code">
                {m.metric.label.toUpperCase()} · {m.metric.better === "higher" ? "MAX" : "MIN"}
              </p>
              <b style={{ color: m.colorOf(lead) }}>
                {formatValue(m.metric.unit, m.results[lead][m.metric.id].value)}
              </b>
              <span>{m.nameOf(lead)}</span>
              <small>{spread(m.metric, m.results[lead][m.metric.id])}</small>
            </div>
          )}
          <p className="ins-dim ins-help">{m.metric.help}</p>
        </aside>
        <section>
          <table className="ins-grid">
            <thead>
              <tr>
                <th>Contestant</th>
                {card.metrics.map((mm) => (
                  <th key={mm.id}>
                    <button
                      onClick={() => m.set({ m: mm.id })}
                      aria-pressed={mm.id === m.metric.id}
                    >
                      {mm.label}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ranked.map((id) => (
                <tr
                  key={id}
                  className={m.focus && m.focus !== id ? "dim" : ""}
                  onMouseEnter={() => m.setFocus(id)}
                  onMouseLeave={() => m.setFocus(null)}
                >
                  <th>
                    <span className="ins-sw" style={{ background: m.colorOf(id) }} />
                    {m.nameOf(id)}
                  </th>
                  {card.metrics.map((mm) => {
                    const e = m.results[id]?.[mm.id];

                    const col = m.resultIds
                      .map((x) => m.results[x]?.[mm.id]?.value)
                      .filter((v): v is number => v != null && !Number.isNaN(v));

                    const max = mm.unit === "%" ? 1 : Math.max(...col) || 1;
                    const best = e && col.every((v) => better(mm, e.value, v) <= 0);

                    return (
                      <td key={mm.id} className={best ? "best" : ""}>
                        <span
                          className="ins-cell-bar"
                          style={{
                            width: `${e ? Math.max(2, (e.value / max) * 100) : 0}%`,
                            background: m.colorOf(id),
                          }}
                        />
                        <span>{formatValue(mm.unit, e?.value)}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ins-controls">
            <Contestants model={m} />
            <div className="ins-seg" role="tablist">
              {card.lenses
                .filter((l) => l !== "table")
                .map((l) => (
                  <button
                    key={l}
                    role="tab"
                    aria-selected={l === m.lens}
                    onClick={() => m.set({ lens: l })}
                  >
                    {LENS_LABEL[l].toUpperCase()}
                  </button>
                ))}
            </div>
          </div>
          <LensView model={m} />
          <p className="ins-code ins-prov">{card.provenance}</p>
        </section>
      </div>
    </div>
  );
}
