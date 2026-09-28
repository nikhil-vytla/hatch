/**
 * Jev Daily: trust or override. Five puzzles a day whose answers are fixed by how they were
 * made. Jev answers first and says how sure it is; beside that, how often it is right at that
 * confidence on puzzles of this kind. You keep its answer or overrule it. Most puzzles are ones
 * where Jev hesitates, where a careful person can add something; one a day is one it is sure
 * of. Scoring is plain: how many you got, against how many Jev alone would have. Your answers
 * stay in this browser.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  jevPick,
  optionKeys,
  pickDaily,
  dailySchema,
  truthKey,
  type Band,
  type Daily,
  type DailyItem,
} from "../../../packages/arena/src/checkable/daily";
import "./daily.css";

const KIND_LABEL: Record<DailyItem["kind"], string> = {
  tetris: "Tetris",
  grid: "Maze",
  phrase: "What will this become?",
  order: "Café order",
  route: "Who gets this?",
};

/** What a puzzle is asking, in a sentence, for kinds whose state carries a long task line. */
const KIND_TASK: Partial<Record<DailyItem["kind"], string>> = {
  order: "Judge the barista's drink against what the customer still wants.",
  route: "Route the message by the policy; the first rule that applies wins.",
};

type Played = { pick: string; right: boolean; trusted: boolean; jevRight: boolean };

const today = () => new Date().toISOString().slice(0, 10);

const label = (key: string, item: DailyItem) => {
  const q = item.question;

  if (q.type === "noul") return key === "true" ? "True" : "False";

  if (q.type === "choice") return q.criteria[key] ?? key;

  return q.criteria[Number(key)] ?? key;
};

const pct = (p: number) => (p > 0.99 && p < 1 ? "over 99%" : `${Math.round(p * 100)}%`);

/** The band Jev's confidence falls in, for this kind; a thin band borrows every kind's. */
function bandFor(calibration: Daily["calibration"], item: DailyItem): Band | undefined {
  const { p } = jevPick(item);
  const find = (bands: Band[] | undefined) =>
    bands?.find((b) => p >= b.lo && (p < b.hi || b.hi >= 1));

  const own = find(calibration[item.kind]);

  if (own && own.n >= 5) return own;

  const pooled = Object.values(calibration).flatMap((bands) => {
    const b = find(bands);

    return b ? [b] : [];
  });

  if (!pooled.length) return undefined;

  return {
    lo: pooled[0].lo,
    hi: pooled[0].hi,
    n: pooled.reduce((s, b) => s + b.n, 0),
    right: pooled.reduce((s, b) => s + b.right, 0),
  };
}

const OUTCOME = {
  trustRight: { mark: "🟩", text: "You trusted Jev, and it was right." },
  trustWrong: { mark: "🟨", text: "Jev was wrong, and you went along with it." },
  overrideRight: { mark: "🟦", text: "Good call: you overruled Jev and you were right." },
  overrideWrong: { mark: "🟥", text: "Jev was right; overruling it cost you this one." },
  bothWrong: { mark: "🟥", text: "You overruled Jev, but you were both wrong." },
} as const;

function outcomeOf(p: Played) {
  if (p.trusted) return p.right ? OUTCOME.trustRight : OUTCOME.trustWrong;

  if (p.right) return OUTCOME.overrideRight;

  return p.jevRight ? OUTCOME.overrideWrong : OUTCOME.bothWrong;
}

function Board({ rows, title }: { rows: string[]; title: string }) {
  return (
    <figure className="dy-board">
      <div
        className="dy-cells"
        style={{ gridTemplateColumns: `repeat(${rows[0]?.length ?? 10}, 1fr)` }}
        role="img"
        aria-label={title}
      >
        {rows.flatMap((row, y) =>
          Array.from(row).map((c, x) => (
            <span key={`${y}-${x}`} data-c={c === "#" ? "fill" : c === "@" ? "piece" : "empty"} />
          )),
        )}
      </div>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

const GRID_LABEL: Record<string, string> = {
  "#": "wall",
  ".": "floor",
  A: "agent",
  K: "key",
  D: "door",
  E: "exit",
};

function Grid({ rows }: { rows: string[] }) {
  return (
    <div
      className="dy-grid"
      style={{ gridTemplateColumns: `repeat(${rows[0]?.length ?? 9}, 1fr)` }}
      role="img"
      aria-label={`Maze, rows top to bottom: ${rows.join(" / ")}. A agent, K key, D locked door, E exit.`}
    >
      {rows.flatMap((row, y) =>
        Array.from(row).map((c, x) => (
          <span key={`${y}-${x}`} data-c={GRID_LABEL[c] ?? "floor"}>
            {c === "#" || c === "." ? "" : c}
          </span>
        )),
      )}
    </div>
  );
}

/** A judgement puzzle's state: every field as a labelled block of text, in the order given. */
function Card({ state }: { state: Record<string, unknown> }) {
  return (
    <dl className="dy-card">
      {Object.entries(state)
        .filter(([k]) => k !== "task")
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k.replaceAll("_", " ")}</dt>
            <dd>
              {typeof v === "string" ? (
                v
              ) : Array.isArray(v) ? (
                <ol>
                  {v.map((line, i) => (
                    <li key={i}>{String(line)}</li>
                  ))}
                </ol>
              ) : v && typeof v === "object" ? (
                <table className="dy-facts">
                  <tbody>
                    {Object.entries(v).map(([fk, fv]) => (
                      <tr key={fk}>
                        <th scope="row">{fk.replaceAll("_", " ")}</th>
                        <td>{String(fv)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                String(v)
              )}
            </dd>
          </div>
        ))}
    </dl>
  );
}

const rowsOf = (v: unknown) =>
  Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : [];

function Puzzle({ item }: { item: DailyItem }) {
  if (item.kind === "grid") return <Grid rows={rowsOf(item.state.grid)} />;

  if (item.kind === "phrase") return <p className="dy-typed">{String(item.state.text ?? "")}</p>;

  if (item.kind === "order" || item.kind === "route") return <Card state={item.state} />;
  const landings =
    item.state.landings && typeof item.state.landings === "object" ? item.state.landings : {};

  return (
    <div className="dy-tetris">
      <Board
        rows={rowsOf(item.state.board)}
        title={`Now: the ${String(item.state.piece)} piece is next`}
      />
      {Object.entries(landings).map(([k, rows]) => (
        <Board key={k} rows={rowsOf(rows)} title={`Landing ${k}`} />
      ))}
    </div>
  );
}

function JevSays({ item, band }: { item: DailyItem; band?: Band }) {
  const { key, p } = jevPick(item);

  return (
    <div className="dy-jev" aria-live="polite">
      <p className="dy-jev-line">
        <span className="dy-jev-name">Jev says</span> <b>{label(key, item)}</b>{" "}
        <span className="dy-jev-conf">{pct(p)} sure</span>
      </p>
      {band && band.n > 0 && (
        <p className="dy-jev-record">
          When Jev says {Math.round(band.lo * 100)}–{pct(Math.min(band.hi, 1))} on puzzles like
          this, it is right <b>{pct(band.right / band.n)}</b> of the time ({band.right} of {band.n}
          ).
        </p>
      )}
    </div>
  );
}

export function DailyPage() {
  const [data, setData] = useState<Daily | null>(null);
  const [error, setError] = useState("");
  const date = today();
  const storeKey = `jev-daily/2:${date}`;

  const [played, setPlayed] = useState<Record<string, Played>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? "{}");
    } catch {
      return {};
    }
  });

  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = "Jev Daily · Jev experiments";
    fetch("/daily/daily.json")
      .then((r) => r.json())
      .then((json) => setData(dailySchema.parse(json)))
      .catch(() => setError("Today's puzzles could not be loaded."));
  }, []);

  // The heading exists once the data has loaded; focus it then, as the arena does.
  useEffect(() => {
    if (data) heading.current?.focus({ preventScroll: true });
  }, [data]);

  const items = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.items.map((i) => [i.id, i]));

    return pickDaily(data.items, date).flatMap((id) => byId.get(id) ?? []);
  }, [data, date]);

  if (error)
    return (
      <main className="daily">
        <p className="notice">{error}</p>
      </main>
    );

  if (!data)
    return (
      <main className="daily">
        <p className="muted">Loading today's puzzles…</p>
      </main>
    );

  const item = items[index];
  const done = items.filter((i) => played[i.id]);
  const jevPickKey = item ? jevPick(item).key : "";
  const chosen = item ? (played[item.id]?.pick ?? choice ?? jevPickKey) : "";

  const go = (n: number) => {
    setIndex(n);
    setChoice(null);
  };

  const lock = () => {
    if (!item) return;
    const right = truthKey(item.truth);

    const next = {
      ...played,
      [item.id]: {
        pick: chosen,
        right: chosen === right,
        trusted: chosen === jevPickKey,
        jevRight: jevPickKey === right,
      },
    };

    setPlayed(next);
    localStorage.setItem(storeKey, JSON.stringify(next));
  };

  const mine = done.filter((i) => played[i.id].right).length;
  const jevAlone = done.filter((i) => played[i.id].jevRight).length;
  const overrides = done.filter((i) => !played[i.id].trusted);
  const goodOverrides = overrides.filter((i) => played[i.id].right).length;
  const grid = items.map((i) => (played[i.id] ? outcomeOf(played[i.id]).mark : "⬜")).join("");

  return (
    <main className="daily" id="main-content" tabIndex={-1}>
      <p className="kicker">Jev Daily · {date}</p>
      <h1 ref={heading} tabIndex={-1}>
        Trust Jev, or overrule it?
      </h1>
      <p className="lede">
        Five puzzles. Jev answers first and says how sure it is, and beside that, how often it is
        really right when it says so. Sometimes it's overconfident, sometimes too modest. Keep its
        answer or pick your own.
      </p>

      <ol className="dy-progress" aria-label="Today's puzzles">
        {items.map((i, n) => (
          <li key={i.id}>
            <button
              type="button"
              aria-current={n === index ? "step" : undefined}
              onClick={() => go(n)}
            >
              {played[i.id] ? outcomeOf(played[i.id]).mark : n + 1}
              <span className="sr-only">{played[i.id] ? ` puzzle ${n + 1}, played` : ""}</span>
            </button>
          </li>
        ))}
      </ol>

      {item && (
        <section className="dy-item" aria-labelledby="dy-q">
          <p className="muted small">
            {KIND_LABEL[item.kind]} · puzzle {index + 1} of {items.length}
            {KIND_TASK[item.kind] ? ` · ${KIND_TASK[item.kind]}` : ""}
          </p>
          <h2 id="dy-q">
            {item.question.type === "noul" && <span className="muted">True or false: </span>}
            {item.question.instructions}
          </h2>
          <Puzzle item={item} />
          <JevSays item={item} band={bandFor(data.calibration, item)} />

          <div className="dy-options" role="radiogroup" aria-labelledby="dy-q">
            {optionKeys(item.question).map((k) => {
              const result = played[item.id];
              const isRight = result && k === truthKey(item.truth);

              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={chosen === k}
                  className="dy-option"
                  data-chosen={chosen === k}
                  data-right={Boolean(isRight)}
                  disabled={Boolean(result)}
                  onClick={() => setChoice(k)}
                >
                  <span>{label(k, item)}</span>
                  {k === jevPickKey && <small>Jev's pick</small>}
                  {isRight && <small className="dy-truth">right answer</small>}
                </button>
              );
            })}
          </div>

          {!played[item.id] ? (
            <button type="button" className="dy-lock" onClick={lock}>
              {chosen === jevPickKey ? "Trust Jev" : `Overrule Jev: ${label(chosen, item)}`}
            </button>
          ) : (
            <>
              <p className="finding">{outcomeOf(played[item.id]).text}</p>
              {index < items.length - 1 && (
                <button type="button" className="dy-lock" onClick={() => go(index + 1)}>
                  Next puzzle
                </button>
              )}
            </>
          )}
        </section>
      )}

      {done.length === items.length && items.length > 0 && (
        <section className="dy-summary" aria-live="polite">
          <h2>
            You got {mine} of {items.length}. Jev alone would have got {jevAlone}.
          </h2>
          <p>
            {overrides.length === 0
              ? "You trusted Jev every time."
              : `You overruled Jev ${overrides.length} time${overrides.length === 1 ? "" : "s"}: ${goodOverrides} good call${goodOverrides === 1 ? "" : "s"}, ${overrides.length - goodOverrides} not.`}{" "}
            Come back tomorrow for five more.
          </p>
          <p className="dy-share" aria-label="Your day as a grid">
            {grid}
          </p>
          <p className="muted small">
            🟩 trusted, right · 🟨 trusted, Jev wrong · 🟦 overruled, right · 🟥 overruled, wrong
          </p>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(
                `Jev Daily ${date}\n${grid}\nme ${mine}/${items.length} · Jev alone ${jevAlone}/${items.length}`,
              )
            }
          >
            Copy your result
          </button>
        </section>
      )}

      <p className="dy-honest muted small">
        Jev's answers were recorded on{" "}
        {new Date(data.recordedAt).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })}
        , before today; every right answer comes from how the puzzle was made.
      </p>
    </main>
  );
}
