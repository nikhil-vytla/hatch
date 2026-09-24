/** PROTOTYPE variant B, "Storybook": warm and illustrated. Each card is a match between characters; the main metric is a race. */
import type { ArenaIndex, Card } from "../../../../packages/arena/src/data/schema";
import { Contestants, LensView, LENS_LABEL, useCardModel, better } from "../card";
import { formatValue, type View } from "../data";
import { cardHref, standings } from "./shared";

/** A contestant as a character: code players are square robots, models are round. */
export function Face({
  color,
  kind,
  size = 44,
  mood = "calm",
}: {
  color: string;
  kind: string;
  size?: number;
  mood?: "calm" | "happy" | "puzzled";
}) {
  const round = kind !== "code";

  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden="true" className="sb-face">
      {round ? (
        <circle cx="22" cy="23" r="18" fill={color} />
      ) : (
        <rect x="5" y="6" width="34" height="34" rx="7" fill={color} />
      )}
      {!round && (
        <line
          x1="22"
          y1="6"
          x2="22"
          y2="1"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      )}
      <circle cx="16" cy="21" r="3" fill="#fffaf0" />
      <circle cx="28" cy="21" r="3" fill="#fffaf0" />
      <circle cx="16.8" cy="21.6" r="1.4" fill="#2b2118" />
      <circle cx="28.8" cy="21.6" r="1.4" fill="#2b2118" />
      {mood === "happy" ? (
        <path
          d="M15 29 Q22 35 29 29"
          stroke="#2b2118"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      ) : mood === "puzzled" ? (
        <path
          d="M16 31 Q20 28 23 31 T29 30"
          stroke="#2b2118"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      ) : (
        <path d="M17 30 H27" stroke="#2b2118" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}

function Vignette({ card }: { card: Card }) {
  if (card.family === "game")
    return (
      <svg viewBox="0 0 220 120" className="sb-vignette" aria-hidden="true">
        <rect x="0" y="0" width="220" height="120" rx="18" fill="#ffe7c2" />
        {[
          [70, 88],
          [86, 88],
          [102, 88],
          [118, 88],
          [86, 72],
          [150, 88],
          [134, 88],
          [150, 72],
        ].map(([x, y], i) => (
          <rect
            key={i}
            x={x}
            y={y}
            width="15"
            height="15"
            rx="3"
            fill={i < 5 ? "#e8553d" : "#5aa9e6"}
          />
        ))}
        <g transform="translate(96 16)">
          <rect width="15" height="15" rx="3" fill="#3f9a6b" />
          <rect x="16" width="15" height="15" rx="3" fill="#3f9a6b" />
          <rect x="16" y="16" width="15" height="15" rx="3" fill="#3f9a6b" />
          <circle cx="20" cy="6" r="2" fill="#fff" />
          <circle cx="27" cy="6" r="2" fill="#fff" />
        </g>
        {card.id === "tetris-realtime" && (
          <g transform="translate(24 20)">
            <circle r="16" cx="16" cy="16" fill="#fff" stroke="#3a2e22" strokeWidth="2.5" />
            <path
              d="M16 16 V6 M16 16 L23 20"
              stroke="#3a2e22"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </g>
        )}
      </svg>
    );

  if (card.family === "robustness")
    return (
      <svg viewBox="0 0 220 120" className="sb-vignette" aria-hidden="true">
        <rect width="220" height="120" rx="18" fill="#e3f0fb" />
        <rect
          x="40"
          y="22"
          width="56"
          height="76"
          rx="28"
          fill="#fff"
          stroke="#3a2e22"
          strokeWidth="2.5"
        />
        <rect
          x="124"
          y="22"
          width="56"
          height="76"
          rx="28"
          fill="#fff"
          stroke="#3a2e22"
          strokeWidth="2.5"
        />
        <circle cx="68" cy="60" r="14" fill="#3f9a6b" />
        <circle cx="152" cy="60" r="14" fill="#3f9a6b" opacity=".85" />
        <path d="M102 60 h16" stroke="#3a2e22" strokeWidth="2.5" strokeDasharray="4 4" />
      </svg>
    );

  return (
    <svg viewBox="0 0 220 120" className="sb-vignette" aria-hidden="true">
      <rect width="220" height="120" rx="18" fill="#efe6fb" />
      {[40, 90, 140].map((x, i) => (
        <g key={x} transform={`translate(${x} 34)`}>
          <rect width="44" height="56" rx="8" fill="#fff" stroke="#3a2e22" strokeWidth="2" />
          <rect
            x="8"
            y="12"
            width="28"
            height="5"
            rx="2"
            fill={["#e8553d", "#5aa9e6", "#3f9a6b"][i]}
          />
          <rect x="8" y="24" width="20" height="5" rx="2" fill="#d7cbb8" />
          <rect x="8" y="36" width="24" height="5" rx="2" fill="#d7cbb8" />
        </g>
      ))}
    </svg>
  );
}

export function StorybookOverview({ index, view }: { index: ArenaIndex; view: View }) {
  return (
    <div className="sb">
      <header className="sb-hero">
        <h1>Pick a match.</h1>
        <p>
          Every card is a little contest: the same situation, handed to different minds. Watch who
          wins, and why.
        </p>
      </header>
      <div className="sb-cards">
        {index.cards.map((card) => {
          const s = standings(card);

          return (
            <a key={card.id} className="sb-ticket" href={cardHref(card, view)}>
              <Vignette card={card} />
              <div className="sb-ticket-body">
                <h2>{card.title}</h2>
                <div className="sb-cast">
                  {s.rows.map((r, i) => (
                    <span key={r.id} title={r.c.name}>
                      <Face
                        color={r.c.color}
                        kind={r.c.kind}
                        size={34}
                        mood={i === 0 ? "happy" : "calm"}
                      />
                    </span>
                  ))}
                </div>
                {s.lead && (
                  <p className="sb-ribbon">
                    Winner so far: <b>{s.lead.c.short}</b> ·{" "}
                    {formatValue(s.metric.unit, s.lead.e.value)} {s.metric.label.toLowerCase()}
                  </p>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

export function StorybookCard({ card, view }: { card: Card; view: View }) {
  const m = useCardModel(card, view);

  const ranked = [...m.resultIds].sort((a, b) =>
    better(
      m.metric,
      m.results[a][m.metric.id]?.value ?? NaN,
      m.results[b][m.metric.id]?.value ?? NaN,
    ),
  );

  const values = ranked.map((id) => m.results[id][m.metric.id]?.value ?? 0);
  const max = m.metric.unit === "%" ? 1 : Math.max(...values, 0) || 1;
  const pos = (v: number) => (m.metric.better === "higher" ? v / max : 1 - v / max + 0.02);

  return (
    <div className="sb sb-card">
      <nav>
        <a href={`#/arena${view.v ? `?v=${view.v}` : ""}`}>← All matches</a>
        <button className="sb-btn" onClick={m.copy}>
          {m.copied ? "Link copied!" : "Share this match"}
        </button>
      </nav>
      <header className="sb-card-head">
        <Vignette card={card} />
        <div>
          <p className="sb-kicker">
            {card.family === "game"
              ? "A game"
              : card.family === "robustness"
                ? "A test of nerves"
                : "A quiz"}
          </p>
          <h1>{card.title}</h1>
          <p>{card.question}</p>
        </div>
      </header>
      <section className="sb-race" aria-label={`${m.metric.label} race`}>
        <p className="sb-race-title">
          The race: <b>{m.metric.label.toLowerCase()}</b>{" "}
          <span>
            (
            {m.metric.better === "higher"
              ? "further right wins"
              : "further right is lower, which wins"}
            )
          </span>
        </p>
        {ranked.map((id, i) => {
          const e = m.results[id][m.metric.id];
          const c = card.contestants.find((x) => x.id === id);

          return (
            <div key={id} className="sb-lane">
              <span className="sb-lane-name">
                {i === 0 && (
                  <span className="sb-crown" aria-label="leader">
                    ★
                  </span>
                )}
                {m.nameOf(id, true)}
              </span>
              <span className="sb-track">
                <span
                  className="sb-runner"
                  style={{ left: `calc(${Math.max(0, Math.min(1, pos(e.value))) * 100}% - 20px)` }}
                >
                  <Face
                    color={m.colorOf(id)}
                    kind={c?.kind ?? "hosted"}
                    size={40}
                    mood={i === 0 ? "happy" : i === ranked.length - 1 ? "puzzled" : "calm"}
                  />
                </span>
              </span>
              <b className="sb-lane-value">{formatValue(m.metric.unit, e.value)}</b>
            </div>
          );
        })}
      </section>
      <section className="sb-panel">
        <Contestants model={m} />
        <div className="sb-tabs" role="tablist">
          {card.lenses.map((l) => (
            <button
              key={l}
              role="tab"
              aria-selected={l === m.lens}
              onClick={() => m.set({ lens: l })}
            >
              {LENS_LABEL[l]}
            </button>
          ))}
        </div>
        {["bars", "per-item"].includes(m.lens) && (
          <label className="sb-metric">
            Race on{" "}
            <select value={m.metric.id} onChange={(e) => m.set({ m: e.target.value })}>
              {card.metrics.map((mm) => (
                <option key={mm.id} value={mm.id}>
                  {mm.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <LensView model={m} />
      </section>
      <p className="sb-small">{card.provenance}</p>
    </div>
  );
}
