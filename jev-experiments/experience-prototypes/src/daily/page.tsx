/**
 * Jev Daily: five shared puzzles a day whose answers code can check. You spread your
 * confidence first; then Jev's recorded answer and the truth are revealed and both are scored
 * the same way. Jev's answers were recorded before the day; the page says how often Jev is
 * wrong when it is sure, before you see it be wrong. Your answers stay in this browser.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CLAMP,
  dailySchema,
  optionKeys,
  score,
  truthKey,
  type Daily,
  type DailyItem,
} from "../../../packages/arena/src/checkable/daily";
import { dailySet } from "../../../packages/arena/src/checkable/items";
import "./daily.css";

const CHIPS = 10;

type Played = { mine: Record<string, number>; you: number; jev: number };

const today = () => new Date().toISOString().slice(0, 10);

const label = (key: string, item: DailyItem) => {
  const q = item.question;

  if (q.type === "noul") return key === "true" ? "Yes" : "No";

  if (q.type === "choice") return q.criteria[key] ?? key;

  return q.criteria[Number(key)] ?? key;
};

function Board({ rows, title }: { rows: string[]; title: string }) {
  return (
    <figure className="dy-board">
      <div className="dy-cells" style={{ gridTemplateColumns: `repeat(${rows[0]?.length ?? 10}, 1fr)` }} role="img" aria-label={title}>
        {rows.flatMap((row, y) =>
          Array.from(row).map((c, x) => <span key={`${y}-${x}`} data-c={c === "#" ? "fill" : c === "@" ? "piece" : "empty"} />),
        )}
      </div>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

const GRID_LABEL: Record<string, string> = { "#": "wall", ".": "floor", A: "agent", K: "key", D: "door", E: "exit" };

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

const rowsOf = (v: unknown) => (Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : []);

function Puzzle({ item }: { item: DailyItem }) {
  if (item.kind === "grid") return <Grid rows={rowsOf(item.state.grid)} />;
  const landings = item.state.landings && typeof item.state.landings === "object" ? item.state.landings : {};

  return (
    <div className="dy-tetris">
      <Board rows={rowsOf(item.state.board)} title={`Now: the ${String(item.state.piece)} piece is next`} />
      {Object.entries(landings).map(([k, rows]) => (
        <Board key={k} rows={rowsOf(rows)} title={`Landing ${k}`} />
      ))}
    </div>
  );
}

/** Your confidence as chips across the options; a yes/no is a single slider. */
function Pick({
  item,
  mine,
  onChange,
  locked,
}: {
  item: DailyItem;
  mine: Record<string, number>;
  onChange: (m: Record<string, number>) => void;
  locked: boolean;
}) {
  const keys = optionKeys(item.question);

  if (item.question.type === "noul") {
    const yes = mine.true ?? 0.5;

    return (
      <label className="dy-slider">
        <span>
          True <b>{Math.round(yes * 100)}%</b> · False <b>{Math.round((1 - yes) * 100)}%</b>
        </span>
        <input
          type="range"
          min={0.01}
          max={0.99}
          step={0.01}
          value={yes}
          disabled={locked}
          onChange={(e) => onChange({ true: Number(e.target.value), false: 1 - Number(e.target.value) })}
        />
      </label>
    );
  }

  // Chips placed so far; after locking, the stored probabilities are shown instead.
  const [placed, setPlaced] = useState<number[]>(() => keys.map(() => 0));

  const chips = locked
    ? keys.map((k) => Math.round((mine[k] ?? 0) * CHIPS))
    : placed;

  const used = chips.reduce((a, b) => a + b, 0);

  const move = (i: number, d: number) => {
    const next = [...placed];

    if (next[i] + d < 0 || used + d > CHIPS) return;
    next[i] += d;
    setPlaced(next);
    const spare = (CHIPS - next.reduce((a, b) => a + b, 0)) / keys.length;

    // Unplaced chips are spread evenly, so the probabilities always sum to one.
    onChange(Object.fromEntries(keys.map((k, j) => [k, (next[j] + spare) / CHIPS])));
  };

  return (
    <ul className="dy-chips">
      {keys.map((k, i) => (
        <li key={k}>
          <span className="dy-option">{label(k, item)}</span>
          <button type="button" onClick={() => move(i, -1)} disabled={locked || chips[i] === 0} aria-label={`One chip less on ${label(k, item)}`}>
            −
          </button>
          <span className="dy-stack" aria-label={`${chips[i]} of ${CHIPS} chips`}>
            {Array.from({ length: CHIPS }, (_, j) => (
              <i key={j} data-on={j < chips[i]} />
            ))}
          </span>
          <button type="button" onClick={() => move(i, 1)} disabled={locked || used >= CHIPS} aria-label={`One chip more on ${label(k, item)}`}>
            +
          </button>
        </li>
      ))}
      {!locked && (
        <li className="muted small">
          {CHIPS - used === 0
            ? "All chips placed."
            : `${CHIPS - used} chip${CHIPS - used === 1 ? "" : "s"} left; unplaced chips are spread evenly.`}
        </li>
      )}
    </ul>
  );
}

function Reveal({ item, played }: { item: DailyItem; played: Played }) {
  const keys = optionKeys(item.question);
  const right = truthKey(item.truth);

  return (
    <div className="dy-reveal">
      <table className="results">
        <thead>
          <tr>
            <th scope="col">Answer</th>
            <th scope="col">You</th>
            <th scope="col">Jev</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k} data-right={k === right}>
              <th scope="row">
                {label(k, item)} {k === right && <b className="dy-truth">right answer</b>}
              </th>
              <td>{Math.round((played.mine[k] ?? 0) * 100)}%</td>
              <td>{Math.round((item.jev[k] ?? 0) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="finding">
        You scored {played.you.toFixed(2)}, Jev {played.jev.toFixed(2)} (the log of the probability each
        put on the right answer; closer to 0 is better).{" "}
        {Math.abs(played.you - played.jev) < 0.01 ? "A tie." : played.you > played.jev ? "You beat Jev on this one." : "Jev takes this one."}{" "}
        <span className="muted small">Jev answered in {Math.round(item.jevMs)} ms.</span>
      </p>
    </div>
  );
}

export function DailyPage() {
  const [data, setData] = useState<Daily | null>(null);
  const [error, setError] = useState("");
  const date = today();
  const storeKey = `jev-daily:${date}`;

  const [played, setPlayed] = useState<Record<string, Played>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? "{}");
    } catch {
      return {};
    }
  });

  const [index, setIndex] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const [mine, setMine] = useState<Record<string, number>>({});

  useEffect(() => {
    document.title = "Jev Daily · Jev experiments";
    heading.current?.focus({ preventScroll: true });
    fetch("/daily/daily.json")
      .then((r) => r.json())
      .then((json) => setData(dailySchema.parse(json)))
      .catch(() => setError("Today's puzzles could not be loaded."));
  }, []);

  const items = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.items.map((i) => [i.id, i]));
    const bank = {
      ...data.bank,
      schema: "checkable.bank/1" as const,
      items: data.bank.ids.map((x) => ({ ...x, seed: 0, difficulty: 0, state: {}, questions: {}, truth: {} })),
    };

    return dailySet(bank, date).flatMap((id) => byId.get(id) ?? []);
  }, [data, date]);

  if (error) return <main className="daily"><p className="notice">{error}</p></main>;

  if (!data) return <main className="daily"><p className="muted">Loading today's puzzles…</p></main>;

  const item = items[index];
  const done = items.filter((i) => played[i.id]);
  const sureRate = data.sure.n ? data.sure.right / data.sure.n : NaN;

  const lock = () => {
    if (!item) return;
    const keys = optionKeys(item.question);
    const filled = Object.fromEntries(keys.map((k) => [k, mine[k] ?? 1 / keys.length]));
    const right = truthKey(item.truth);
    const next = { ...played, [item.id]: { mine: filled, you: score(filled[right] ?? 0), jev: score(item.jev[right] ?? 0) } };

    setPlayed(next);
    localStorage.setItem(storeKey, JSON.stringify(next));
  };

  const wins = done.filter((i) => played[i.id].you > played[i.id].jev + 0.01).length;
  const losses = done.filter((i) => played[i.id].jev > played[i.id].you + 0.01).length;
  const grid = items.map((i) => (!played[i.id] ? "⬜" : played[i.id].you > played[i.id].jev + 0.01 ? "🟩" : played[i.id].jev > played[i.id].you + 0.01 ? "🟥" : "🟨")).join("");

  return (
    <main className="daily" id="main-content" tabIndex={-1}>
      <p className="kicker">Jev Daily · {date}</p>
      <h1 ref={heading} tabIndex={-1}>
        Can you out-call Jev today?
      </h1>
      <p className="lede">
        Five puzzles with answers code can check. Spread your confidence, lock it in, then see Jev's recorded answer
        and the truth. Both of you are scored the same way: a hedge costs a little when you're right, a confident
        miss costs a lot.
      </p>
      <p className="dy-honest">
        Jev's answers were recorded on {new Date(data.recordedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}; it can't see your answers or change its own.{" "}
        {Number.isFinite(sureRate) &&
          `When Jev says 90% or more on these puzzles it is right ${Math.round(sureRate * 100)}% of the time (${data.sure.right} of ${data.sure.n}), so expect it to be confidently wrong now and then.`}{" "}
        Probabilities are clamped to {CLAMP * 100}–{100 - CLAMP * 100}%.
      </p>

      <ol className="dy-progress" aria-label="Today's puzzles">
        {items.map((i, n) => (
          <li key={i.id}>
            <button type="button" aria-current={n === index ? "step" : undefined} onClick={() => { setIndex(n); setMine({}); }}>
              {n + 1}
              <span className="sr-only">{played[i.id] ? " (played)" : ""}</span>
            </button>
          </li>
        ))}
      </ol>

      {item && (
        <section className="dy-item" aria-labelledby="dy-q">
          <p className="muted small">
            {item.kind === "tetris" ? "Tetris" : "Maze"} · puzzle {index + 1} of {items.length}
          </p>
          <h2 id="dy-q">
            {item.question.type === "noul" && <span className="muted">True or false: </span>}
            {item.question.instructions}
          </h2>
          {item.kind === "grid" && typeof item.state.legend === "string" && <p className="muted small">{item.state.legend}</p>}
          <Puzzle item={item} />
          <Pick key={item.id} item={item} mine={played[item.id]?.mine ?? mine} onChange={setMine} locked={Boolean(played[item.id])} />
          {!played[item.id] ? (
            <button type="button" className="dy-lock" onClick={lock}>
              Lock it in
            </button>
          ) : (
            <>
              <Reveal item={item} played={played[item.id]} />
              {index < items.length - 1 && (
                <button type="button" className="dy-lock" onClick={() => { setIndex(index + 1); setMine({}); }}>
                  Next puzzle
                </button>
              )}
            </>
          )}
        </section>
      )}

      {done.length === items.length && items.length > 0 && (
        <section className="dy-summary" aria-live="polite">
          <h2>Today: you {wins}, Jev {losses}</h2>
          <p>
            Your total {done.reduce((s, i) => s + played[i.id].you, 0).toFixed(2)} against Jev's{" "}
            {done.reduce((s, i) => s + played[i.id].jev, 0).toFixed(2)}. Five puzzles is too few to say who is better
            in general; come back tomorrow.
          </p>
          <p className="dy-share">{grid}</p>
          <button type="button" onClick={() => void navigator.clipboard.writeText(`Jev Daily ${date}\n${grid}\nyou ${wins} · Jev ${losses}`)}>
            Copy your result
          </button>
        </section>
      )}
    </main>
  );
}
