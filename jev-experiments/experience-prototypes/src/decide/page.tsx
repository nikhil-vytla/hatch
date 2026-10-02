/**
 * Decide: everyday calls a decision model makes, asked blind. The visitor picks first; only
 * then does the page show how other visitors split, how each model chose, and how the same call
 * moves when it is asked another way: different wording, another answer shape, more context,
 * or split into small questions that code combines. Each setup opens to the exact request, the
 * rule that turns answers into the split shown, and every model's raw answers. The small
 * classifier can be re-run in the visitor's own browser.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  decideSchema,
  tallySchema,
  type DecideData,
  type DecideDecision,
  type DecideSetup,
} from "../../../packages/arena/src/decide/data";
import type { Dist, WireAnswer } from "../../../packages/arena/src/decide/combine";
import { combine, wireAnswerSchema } from "../../../packages/arena/src/decide/combine";
import { getApiKey, run as runJev } from "../api";
import { fromLive, Receipt, type ReceiptData } from "../receipt";
import { z } from "zod";
import type { Combine } from "../../../packages/arena/src/decide/deck";
import "./decide.css";

const STORE = "jev-decide/1";

const GROUP_LABEL: Record<DecideSetup["group"], string> = {
  wording: "Wording",
  shape: "Answer shape",
  context: "Context",
  split: "Split up",
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

const WORDS = ["no", "one", "two", "three", "four", "five"];

/** JSON with numbers cut to three places, for reading rather than replaying. */
const readable = (x: unknown) =>
  JSON.stringify(
    x,
    (_, v) => (typeof v === "number" && !Number.isInteger(v) ? Number(v.toFixed(3)) : v),
    2,
  );

const topOf = (d: DecideDecision, dist: Dist) =>
  d.options.reduce(
    (best, o) => ((dist[o.id] ?? 0) > (dist[best.id] ?? 0) ? o : best),
    d.options[0],
  );

function loadPicks(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE) ?? "{}");

    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function State({
  state,
  context,
}: {
  state: Record<string, string>;
  context?: Record<string, string>;
}) {
  return (
    <dl className="dc-state">
      {Object.entries(state).map(([k, v]) => (
        <div key={k}>
          <dt>{k.replaceAll("_", " ")}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      {context &&
        Object.entries(context).map(([k, v]) => (
          <div key={k} className="dc-context">
            <dt>{k.replaceAll("_", " ")}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** A split bar over the options, labelled with each share. */
function Split({ d, dist, mine }: { d: DecideDecision; dist: Dist; mine?: string }) {
  return (
    <div
      className="dc-split"
      role="img"
      aria-label={d.options.map((o) => `${o.label} ${pct(dist[o.id] ?? 0)}`).join(", ")}
    >
      {d.options.map((o, i) => {
        const p = dist[o.id] ?? 0;

        return (
          <span
            key={o.id}
            data-i={i}
            data-mine={o.id === mine}
            style={{ flexGrow: Math.max(p, 0.001) }}
          >
            {p >= 0.12 && (
              <>
                {o.label} <b>{pct(p)}</b>
              </>
            )}
          </span>
        );
      })}
    </div>
  );
}

function Crowd({ d, mine }: { d: DecideDecision; mine: string }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [off, setOff] = useState(false);

  useEffect(() => {
    let live = true;

    fetch("/api/tally", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: d.id, option: mine }),
    })
      .then((r) => r.json())
      .then((json) => {
        const t = tallySchema.parse(json);

        if (!live) return;

        if (!t.available || !t.counts) setOff(true);
        else setCounts(t.counts);
      })
      .catch(() => live && setOff(true));

    return () => {
      live = false;
    };
  }, [d.id, mine]);

  if (off) return null;

  if (!counts) return <p className="muted small">Counting votes…</p>;

  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const dist = Object.fromEntries(
    d.options.map((o) => [o.id, total ? (counts[o.id] ?? 0) / total : 0]),
  );
  const same = total ? (counts[mine] ?? 0) / total : 0;

  return (
    <section className="dc-block" aria-labelledby={`crowd-${d.id}`}>
      <h3 id={`crowd-${d.id}`}>Everyone</h3>
      <p>
        {total <= 1
          ? "You're the first to answer this one."
          : `${pct(same)} of ${total.toLocaleString()} visitors chose what you chose.`}
      </p>
      {total > 1 && <Split d={d} dist={dist} mine={mine} />}
    </section>
  );
}

type Live = {
  status: "idle" | "loading" | "running" | "done" | "error";
  percent?: number;
  message?: string;
  answers: Record<string, Record<string, WireAnswer>>;
};

function useLiveNli(d: DecideDecision) {
  const [live, setLive] = useState<Live>({ status: "idle", answers: {} });
  const worker = useRef<Worker | null>(null);

  useEffect(() => {
    setLive({ status: "idle", answers: {} });

    return () => {
      worker.current?.terminate();
      worker.current = null;
    };
  }, [d.id]);

  type Job = { id: string; request: DecideSetup["request"] };

  const run = (jobs: Job[] = d.setups.map((s) => ({ id: s.id, request: s.request }))) => {
    worker.current?.terminate();
    const w = new Worker(new URL("./nli.worker.ts", import.meta.url), { type: "module" });

    worker.current = w;
    setLive({ status: "loading", percent: 0, answers: {} });
    w.onmessage = (event: MessageEvent) => {
      const m = event.data;

      if (m.type === "progress") setLive((l) => ({ ...l, status: "loading", percent: m.percent }));
      else if (m.type === "answer")
        setLive((l) => ({ ...l, status: "running", answers: { ...l.answers, [m.id]: m.answers } }));
      else if (m.type === "done") setLive((l) => ({ ...l, status: "done" }));
      else if (m.type === "error") setLive((l) => ({ ...l, status: "error", message: m.message }));
    };
    w.postMessage({ jobs });
  };

  return { live, run };
}

function Code({
  d,
  s,
  data,
  live,
}: {
  d: DecideDecision;
  s: DecideSetup;
  data: DecideData;
  live?: Record<string, WireAnswer>;
}) {
  return (
    <div className="dc-code">
      <p className="dc-code-label">Request (the same for every model)</p>
      <pre>{JSON.stringify(s.request, null, 2)}</pre>
      <p className="dc-code-label">How the answers become the split</p>
      <pre>{s.rule}</pre>
      <p className="dc-code-label">What each model answered</p>
      <pre>
        {readable(
          Object.fromEntries([
            ...data.contestants.flatMap((c) =>
              s.results[c.id] ? [[c.name, s.results[c.id].answers]] : [],
            ),
            ...(live ? [["MobileBERT, just now in your browser", live]] : []),
          ]),
        )}
      </pre>
    </div>
  );
}

function Reveal({ d, data, mine }: { d: DecideDecision; data: DecideData; mine: string }) {
  const neutral = d.setups.find((s) => s.id === "neutral") ?? d.setups[0];
  const [open, setOpen] = useState<string | null>(null);
  const { live, run } = useLiveNli(d);
  const liveDist = (s: DecideSetup) => {
    const a = live.answers[s.id];

    return a ? combine(s.combine as Combine, d.options, a) : undefined;
  };

  const columns = [
    ...data.contestants,
    ...(live.status !== "idle"
      ? [{ id: "live", name: "In your browser", about: "", model: "" }]
      : []),
  ];

  const changed = d.setups.filter((s) =>
    data.contestants.some((c) => {
      const a = s.results[c.id];
      const b = neutral.results[c.id];

      return a && b && topOf(d, a.dist).id !== topOf(d, b.dist).id;
    }),
  ).length;

  return (
    <div className="dc-reveal">
      {d.truth && (
        <p className="dc-truth" data-right={d.truth.option === mine}>
          <b>{d.truth.option === mine ? "Right." : "Not quite."}</b> This one has an answer:{" "}
          {d.options.find((o) => o.id === d.truth?.option)?.label}. {d.truth.why}
        </p>
      )}

      <Crowd d={d} mine={mine} />

      <section className="dc-block" aria-labelledby={`models-${d.id}`}>
        <h3 id={`models-${d.id}`}>The models, asked plainly</h3>
        {data.contestants.map((c) => {
          const r = neutral.results[c.id];

          if (!r) return null;
          const top = topOf(d, r.dist);

          return (
            <div key={c.id} className="dc-model">
              <p>
                <b>{c.name}</b> chose <b>{top.label}</b> ({pct(r.dist[top.id] ?? 0)})
                {top.id === mine ? ", like you." : "."}{" "}
                <span className="muted small">
                  {c.about}
                  {c.recorded ? `; recorded ${c.recorded}` : ""}
                </span>
              </p>
              <Split d={d} dist={r.dist} mine={mine} />
              <Receipt
                data={{
                  mode: "recorded",
                  ms: r.latencyMs,
                  questions: Object.keys(neutral.request.questions).length,
                  costUsd: r.costUsd,
                  at: r.at,
                  model: c.model,
                  raw: { request: neutral.request, response: { answers: r.answers } },
                }}
              />
            </div>
          );
        })}
      </section>

      <section className="dc-block" aria-labelledby={`setups-${d.id}`}>
        <h3 id={`setups-${d.id}`}>Ask it differently</h3>
        <p>
          The same call, set up {d.setups.length} ways.{" "}
          {changed > 0
            ? `On ${changed} of the ${d.setups.length - 1} other setups, at least one model changes its answer.`
            : "Every model holds its answer."}{" "}
          Open a row to see exactly what was sent.
        </p>
        <div className="dc-table-wrap">
          <table className="dc-table">
            <thead>
              <tr>
                <th scope="col">Setup</th>
                {columns.map((c) => (
                  <th scope="col" key={c.id}>
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.setups.map((s) => {
                const isOpen = open === s.id;

                return (
                  <Fragment key={s.id}>
                    <tr>
                      <th scope="row">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : s.id)}
                        >
                          <span className="dc-group">{GROUP_LABEL[s.group]}</span> {s.label}
                        </button>
                      </th>
                      {columns.map((c) => {
                        const dist = c.id === "live" ? liveDist(s) : s.results[c.id]?.dist;
                        const base =
                          c.id === "live" ? liveDist(neutral) : neutral.results[c.id]?.dist;

                        if (!dist)
                          return (
                            <td key={c.id} className="muted">
                              {c.id === "live" ? "…" : "–"}
                            </td>
                          );
                        const top = topOf(d, dist);
                        const flipped = base && topOf(d, base).id !== top.id;

                        return (
                          <td
                            key={c.id}
                            data-flipped={Boolean(flipped)}
                            data-i={d.options.indexOf(top)}
                          >
                            {top.label} <span className="muted">{pct(dist[top.id] ?? 0)}</span>
                          </td>
                        );
                      })}
                    </tr>
                    {isOpen && (
                      <tr className="dc-open">
                        <td colSpan={columns.length + 1}>
                          <Code d={d} s={s} data={data} live={live.answers[s.id]} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Highlighted cells are where a model's answer differs from the plain question.
        </p>
        <div className="dc-live">
          {live.status === "idle" && (
            <button type="button" onClick={() => run()}>
              Run MobileBERT in your browser (about 50 MB, downloaded once)
            </button>
          )}
          {live.status === "loading" && (
            <p className="muted small">Downloading the model… {live.percent ?? 0}%</p>
          )}
          {live.status === "running" && <p className="muted small">Asking it every setup…</p>}
          {live.status === "done" && (
            <p className="muted small">
              Ran on your device; nothing was sent anywhere. It should match the recorded MobileBERT
              column to within a few points (the browser's runtime rounds a little differently).
            </p>
          )}
          {live.status === "error" && (
            <p className="notice">It couldn't run here: {live.message}</p>
          )}
        </div>
      </section>

      <YourWording d={d} data={data} />
    </div>
  );
}

const answersSchema = z.object({ answers: z.record(z.string(), wireAnswerSchema) });

type Asked = { status: "idle" | "running" | "done" | "error"; dist?: Dist; message?: string; receipt?: ReceiptData };

/**
 * The visitor writes their own wording of the plain question. Jev runs it live with the
 * visitor's own key (the site pays nothing); MobileBERT runs it in the browser.
 */
function YourWording({ d, data }: { d: DecideDecision; data: DecideData }) {
  const neutral = d.setups.find((s) => s.id === "neutral") ?? d.setups[0];
  const base = neutral.request.questions.call;
  const [text, setText] = useState(base?.instructions ?? d.ask);
  const [withContext, setWithContext] = useState(false);
  const [jev, setJev] = useState<Asked>({ status: "idle" });
  const { live, run } = useLiveNli(d);

  if (!base || base.type !== "choice") return null;

  const request = {
    state: withContext && d.context ? { ...d.state, ...d.context } : d.state,
    questions: { call: { ...base, instructions: text.trim() } },
  };

  const toDist = (answers: Record<string, WireAnswer>) =>
    combine({ rule: "choice", question: "call" }, d.options, answers);

  const askJev = async () => {
    // The key lives in Settings and can arrive after this panel rendered, so check it now.
    if (!getApiKey()) {
      setJev({
        status: "error",
        message:
          "Connect your AI Gateway key in Settings to run Jev live. It stays in this tab and is billed to you, not the site.",
      });

      return;
    }

    setJev({ status: "running" });

    try {
      const raw: unknown = await runJev(request.state, request.questions);
      const body = answersSchema.parse(raw);

      setJev({ status: "done", dist: toDist(body.answers), receipt: fromLive(raw, request) });
    } catch (e) {
      setJev({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const nli = live.answers.custom;
  const recorded = data.contestants.flatMap((c) =>
    neutral.results[c.id] ? [{ c, dist: neutral.results[c.id].dist }] : [],
  );

  return (
    <section className="dc-block dc-yours" aria-labelledby={`yours-${d.id}`}>
      <h3 id={`yours-${d.id}`}>Try your own wording</h3>
      <p>Rewrite the question and ask it again. The options and the state stay the same.</p>
      <label className="dc-yours-field">
        <span className="sr-only">Your question</span>
        <textarea rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {d.context && (
        <label className="dc-yours-check">
          <input
            type="checkbox"
            checked={withContext}
            onChange={(e) => setWithContext(e.target.checked)}
          />{" "}
          Send the extra context too
        </label>
      )}
      <div className="dc-yours-actions">
        <button
          type="button"
          className="dc-next"
          disabled={!text.trim() || jev.status === "running"}
          onClick={() => void askJev()}
        >
          {jev.status === "running" ? "Asking Jev…" : "Ask Jev with your key"}
        </button>
        <button
          type="button"
          disabled={!text.trim() || live.status === "loading" || live.status === "running"}
          onClick={() => run([{ id: "custom", request }])}
        >
          Ask MobileBERT in your browser
        </button>
      </div>
      <p className="muted small">
        Jev runs with the AI Gateway key you connect in Settings. It stays in this tab, and the
        request is billed to you, not the site.
      </p>
      {jev.status === "error" && <p className="notice">{jev.message}</p>}
      {live.status === "loading" && (
        <p className="muted small">Downloading MobileBERT… {live.percent ?? 0}%</p>
      )}
      {live.status === "error" && (
        <p className="notice">MobileBERT couldn't run here: {live.message}</p>
      )}

      {(jev.dist || nli) && (
        <div className="dc-yours-results">
          {jev.dist && (
            <div className="dc-model">
              <p>
                <b>Jev, your wording</b>
              </p>
              <Split d={d} dist={jev.dist} />
              {jev.receipt && <Receipt data={jev.receipt} />}
            </div>
          )}
          {nli && (
            <div className="dc-model">
              <p>
                <b>MobileBERT, your wording</b> <span className="muted small">in your browser</span>
              </p>
              <Split d={d} dist={toDist(nli)} />
            </div>
          )}
          <p className="muted small">
            Recorded with the neutral wording:{" "}
            {recorded
              .map(
                ({ c, dist }) =>
                  `${c.name} ${topOf(d, dist).label} ${pct(dist[topOf(d, dist).id] ?? 0)}`,
              )
              .join(" · ")}
          </p>
          <details>
            <summary className="small">The request you sent</summary>
            <pre className="dc-code-pre">{JSON.stringify(request, null, 2)}</pre>
          </details>
        </div>
      )}
    </section>
  );
}

export function DecidePage() {
  const [data, setData] = useState<DecideData | null>(null);
  const [error, setError] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>(loadPicks);
  const [index, setIndex] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = "Decide · Jev experiments";
    fetch("/decide/decide.json")
      .then((r) => r.json())
      .then((json) => {
        const parsed = decideSchema.parse(json);
        const saved = loadPicks();
        // A link to one call (#/decide/<id>) opens it; otherwise pick up at the first unanswered one.
        const linked = parsed.decisions.findIndex((d) => location.hash === `#/decide/${d.id}`);
        const next = parsed.decisions.findIndex((d) => !saved[d.id]);

        setData(parsed);
        setIndex(linked !== -1 ? linked : next === -1 ? 0 : next);
      })
      .catch(() => setError("The decisions could not be loaded."));
  }, []);

  useEffect(() => {
    if (data) heading.current?.focus({ preventScroll: true });
  }, [data]);

  const summary = useMemo(() => {
    if (!data) return null;
    const played = data.decisions.filter((d) => picks[d.id]);

    const agree = data.contestants.map((c) => ({
      name: c.name,
      n: played.filter((d) => {
        const r = (d.setups.find((s) => s.id === "neutral") ?? d.setups[0]).results[c.id];

        return r && topOf(d, r.dist).id === picks[d.id];
      }).length,
    }));

    return { played: played.length, agree };
  }, [data, picks]);

  if (error)
    return (
      <main className="decide">
        <p className="notice">{error}</p>
      </main>
    );

  if (!data)
    return (
      <main className="decide">
        <p className="muted">Loading…</p>
      </main>
    );

  const d = data.decisions[index];
  const mine = picks[d.id];

  const pick = (option: string) => {
    const next = { ...picks, [d.id]: option };

    setPicks(next);
    localStorage.setItem(STORE, JSON.stringify(next));
  };

  const go = (n: number) => {
    setIndex(n);
    window.scrollTo({ top: 0 });
  };

  return (
    <main className="decide" id="main-content" tabIndex={-1}>
      <p className="kicker">
        Decide · {index + 1} of {data.decisions.length}
      </p>
      <h1 ref={heading} tabIndex={-1}>
        What would you decide?
      </h1>
      <p className="lede">
        Everyday calls that software makes for you. Pick first. Then see how everyone else split,
        how {WORDS[data.contestants.length] ?? data.contestants.length} models chose, and how their
        answers move when the same call is asked another way.
      </p>

      <section className="dc-card" aria-labelledby="dc-ask">
        <h2 id="dc-ask">{d.ask}</h2>
        <State state={d.state} context={mine ? d.context : undefined} />
        {mine && d.context && (
          <p className="muted small">Shaded rows are extra context only one setup sends.</p>
        )}
        <div className="dc-options" role="group" aria-label="Your answer">
          {d.options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              className="dc-option"
              data-i={i}
              data-mine={o.id === mine}
              disabled={Boolean(mine)}
              onClick={() => pick(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </section>

      {mine && <Reveal key={d.id} d={d} data={data} mine={mine} />}

      <nav className="dc-nav" aria-label="Decisions">
        <button type="button" disabled={index === 0} onClick={() => go(index - 1)}>
          Previous
        </button>
        <button
          type="button"
          className="dc-next"
          disabled={index === data.decisions.length - 1}
          onClick={() => go(index + 1)}
        >
          {mine ? "Next decision" : "Skip"}
        </button>
      </nav>

      {summary && summary.played >= 3 && (
        <p className="dc-summary muted">
          So far you've decided {summary.played}.{" "}
          {summary.agree.map((a) => `${a.name} agreed with you on ${a.n}`).join(", ")}.
        </p>
      )}

      <p className="dc-results-link">
        <a href="#/decide/results">See what all the answers add up to →</a>
      </p>

      <p className="dc-honest muted small">
        Model answers were recorded once and are replayed here, so answering costs nothing. Vote
        counts keep only a tally per option; your picks stay in this browser.
      </p>
    </main>
  );
}
