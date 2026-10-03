/**
 * PROTOTYPE, throwaway (branch proto/page-formats). Three page formats for a research-first site,
 * each on one real flagship page, switched by a query string before the hash:
 *
 *   /?format=article#experiment/decoy       Distill-style article (Distill "Why Momentum Really
 *                                            Works": live figure as hero, method in the body,
 *                                            citable; footnotes after Transformer Circuits)
 *   /?format=report#experiment/answer-key   Report + companion toy (abstract, method, results with
 *                                            intervals, limits, data; toy linked, after The Pudding's
 *                                            "method behind a link" and LMArena's interval tables)
 *   /?format=game#experiment/ocean          Game + evidence drawer (Red Blob Games / Nicky Case:
 *                                            the thing you touch comes first, evidence in a drawer)
 *   /?format=off#experiment/<id>            the live page, with the switcher bar
 *
 * Every number is read from the existing records at runtime; nothing is typed in. Intervals the
 * records don't carry (the report's 95% Wilson intervals) are computed here from the recorded
 * counts, and the page says so.
 */
import { useEffect, useMemo, useState } from "react";
import { Decoy } from "../decoy";
import { AnswerKey } from "../answer-key";
import { OceanReef } from "../ocean-reef";
import { HeadlineStrip, headlineFor, homeHeadline } from "../headline-strip";
import { KEY_MODELS, rank, type Question } from "../../../packages/arena/src/answer-key/model";
import prose from "../../../packages/arena/prose/results.json";
import heldout from "../../../live-worlds/ocean/heldout.json";
import "./formats.proto.css";

export type Format = "article" | "report" | "game" | "off";

export const FORMAT_PAGES: Record<Exclude<Format, "off">, { id: string; label: string }> = {
  article: { id: "decoy", label: "Article · the decoy" },
  report: { id: "answer-key", label: "Report · answer key" },
  game: { id: "ocean", label: "Game · the reef" },
};

/** The format asked for in the query string, if any. */
export function protoFormat(): Format | null {
  const f = new URLSearchParams(location.search).get("format");

  return f === "article" || f === "report" || f === "game" || f === "off" ? f : null;
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

/** 95% Wilson score interval for k successes in n. */
function wilson(p: number, n: number): [number, number] {
  const z = 1.96;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;

  return [mid - half, mid + half];
}

export function FormatBar({ current, id }: { current: Format; id: string }) {
  return (
    <nav className="proto-bar" aria-label="Prototype: page format">
      <span className="proto-bar-tag">Prototype</span>
      <a href={`/?format=off#experiment/${id}`} aria-current={current === "off" ? "page" : undefined}>
        Live page
      </a>
      {(Object.keys(FORMAT_PAGES) as Exclude<Format, "off">[]).map((f) => (
        <a key={f} href={`/?format=${f}#experiment/${FORMAT_PAGES[f].id}`} aria-current={current === f ? "page" : undefined}>
          {FORMAT_PAGES[f].label}
        </a>
      ))}
    </nav>
  );
}

export function FormatProto({ format, id }: { format: Exclude<Format, "off">; id: string }) {
  const page = format === "article" ? <Article /> : format === "report" ? <Report /> : <Game />;

  return (
    <>
      {FORMAT_PAGES[format].id === id ? page : <p className="proto-wrong">This format is prototyped on {FORMAT_PAGES[format].label}.</p>}
      <FormatBar current={format} id={id} />
    </>
  );
}

/* ----------------------------- 1. Distill-style article ----------------------------- */

function Cite({ title, path }: { title: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const text = `Jev experiments (${new Date(prose.run.last).getUTCFullYear()}). "${title}." https://jev-experiments.vercel.app/#experiment/${path}. Recorded ${prose.run.first.slice(0, 10)}.`;

  return (
    <aside className="proto-cite">
      <h3>Cite this</h3>
      <pre>{text}</pre>
      <button type="button" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
        {copied ? "Copied" : "Copy citation"}
      </button>
    </aside>
  );
}

function Article() {
  const h = headlineFor("decoy");
  const home = homeHeadline();
  const d = prose.decoy;
  const run = prose.run;
  const moved = d.scenarios.filter((s) => s.decoyA > s.decoyB).length;

  return (
    <article className="proto-article toybox">
      <header className="proto-article-head">
        <p className="proto-kicker">Research note · recorded {run.first.slice(0, 10)}</p>
        <h1>Does an option nobody should pick change Jev's choice?</h1>
        <p className="proto-verdict">{h?.verdict}</p>
        <p className="proto-byline">
          Jev experiments · {run.answered.toLocaleString()} recorded answers from typesafe-ai/jev · ${run.costUsd.toFixed(3)} at list price
        </p>
      </header>

      <figure className="proto-hero">
        <Decoy />
        <figcaption>
          Figure 1. Toggle the third option. A's share of the choice between A and B moves, though nobody should pick the
          decoy. Recorded answers; nothing here calls a model.
        </figcaption>
      </figure>

      <section>
        <h2>What we did</h2>
        <p>
          We gave Jev {d.scenarios.length} everyday choices (an apartment, a laptop, a job and so on), each between two options
          that trade off. We asked three times: with the two options alone, with a third option worse than A on both counts,
          and with one worse than B. Each set was asked in two orders, {d.scenarios.length * 6} requests in all. This is the
          asymmetric-dominance or decoy design of Huber, Payne and Puto (1982)<sup>1</sup>.
        </p>
      </section>

      <section>
        <h2>What we found</h2>
        <p>
          A's share of the A-versus-B choice was higher next to A's decoy than next to B's in{" "}
          <b>
            {moved} of {d.scenarios.length}
          </b>{" "}
          scenarios, by <b>{(d.effect.mean * 100).toFixed(0)} points</b> on average (95% interval{" "}
          {(d.effect.ci[0] * 100).toFixed(0)} to {(d.effect.ci[1] * 100).toFixed(0)}). Order mattered too: A's share
          was {(d.order.mean * 100).toFixed(0)} points higher when A was listed first than last (interval{" "}
          {(d.order.ci[0] * 100).toFixed(0)} to {(d.order.ci[1] * 100).toFixed(0)}). Intervals bootstrap over the scenarios.
        </p>
        <table className="proto-table">
          <thead>
            <tr>
              <th scope="col">Scenario</th>
              <th scope="col">A's share, alone</th>
              <th scope="col">next to A's decoy</th>
              <th scope="col">next to B's decoy</th>
            </tr>
          </thead>
          <tbody>
            {d.scenarios.map((s) => (
              <tr key={s.item}>
                <th scope="row">{s.item}</th>
                <td>{pct(s.none, 0)}</td>
                <td>{pct(s.decoyA, 0)}</td>
                <td>{pct(s.decoyB, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>A related finding: doubt, not decoys</h2>
        <p>
          In the same study, appending “I'm pretty sure the answer is no.” to a question Jev answered correctly flipped it on{" "}
          <b>{home?.stats[0]?.value}</b> puzzles, including one where no was already right; “…is yes.” flipped none
          <sup>2</sup>. Rewording alone moved {home?.stats[1]?.value} answers.
        </p>
      </section>

      <section>
        <h2>Uncertainty and limits</h2>
        <ul>
          <li>Eight hand-written scenarios; a different set could move less, or more.</li>
          <li>One recording per request; the intervals cover scenario-to-scenario variation, not repeat runs.</li>
          <li>People show the same effect; this says nothing about whether Jev's shift is larger or smaller than theirs.</li>
          <li>
            The study froze its protocol before recording; one recorder fix mid-run is logged in the study's notes.
          </li>
        </ul>
      </section>

      <section>
        <h2>Data</h2>
        <p>
          <a href="/decoy/decoy.json" download>
            decoy.json
          </a>{" "}
          (every request and answer) ·{" "}
          <a href="https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/packages/arena/prose" target="_blank" rel="noreferrer">
            the prose studies
          </a>{" "}
          (protocol, recording, analysis) · {run.inputTokens.toLocaleString()} input tokens, p50 {run.latencyMs.p50} ms.
        </p>
      </section>

      <Cite title="Does an option nobody should pick change Jev's choice?" path="decoy" />

      <footer className="proto-notes">
        <ol>
          <li>Huber, J., Payne, J. W. and Puto, C. (1982). Adding asymmetrically dominated alternatives. Journal of Consumer Research 9(1).</li>
          <li>Fool Jev on the home page replays these recordings.</li>
        </ol>
      </footer>
    </article>
  );
}

/* ----------------------------- 2. Report + companion toy ----------------------------- */

type OpenDoc = { typed: { id: string; name: string; agreement: number; decisions: number }[] };

function Report() {
  const [local, setLocal] = useState<any>(null);
  const [open, setOpen] = useState<OpenDoc | null>(null);
  const [toy, setToy] = useState(false);

  useEffect(() => {
    void fetch("/data/local-models.json").then((r) => r.json()).then((d) => setLocal(d.result));
    void fetch("/open-decisions/open-decisions.json").then((r) => r.json()).then(setOpen);
  }, []);

  const questions: Question[] = useMemo(() => (local?.cases ?? []).flatMap((c: any) => c.questions), [local]);
  const ids = KEY_MODELS.map((m) => m.id);
  const teacher = useMemo(() => (questions.length ? rank(questions, { kind: "teacher" }, ids) : []), [questions]);
  const consensus = useMemo(() => (questions.length ? rank(questions, { kind: "consensus", voters: ids }, ids) : []), [questions]);
  const name = (id: string) => KEY_MODELS.find((m) => m.id === id)?.name ?? id;
  const h = headlineFor("answer-key");
  const n = questions.length;

  return (
    <article className="proto-report toybox">
      <header>
        <p className="proto-kicker">Report · Typed decisions benchmark</p>
        <h1>Who wrote the answer key? Grading five models against different references</h1>
      </header>

      <section className="proto-abstract">
        <h2>Abstract</h2>
        <p>
          {h?.verdict} We re-grade the same {n ? n.toLocaleString() : "…"} recorded answers from five models against the
          benchmark's teacher and against the other models' averaged answers, and compare small open models asked the same
          questions through SGLang's decision method.
        </p>
      </section>

      <section>
        <h2>1. Method</h2>
        <p>
          Questions: the 400 released test cases of LocalLLaMA/typed-decisions (Apache-2.0), five questions each. Each model's
          top option is compared with the key's. Keys: the teacher's distribution, or the mean of the other four models'
          distributions (the graded model never votes on its own key). Intervals are 95% Wilson intervals on the{" "}
          {n ? n.toLocaleString() : "…"} questions, computed in your browser from the recorded counts.
        </p>
      </section>

      <section>
        <h2>2. Results</h2>
        <table className="proto-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Agrees with teacher (95% CI)</th>
              <th scope="col">Agrees with the others' average (95% CI)</th>
            </tr>
          </thead>
          <tbody>
            {teacher.map((r) => {
              const c = consensus.find((x) => x.model === r.model);
              const [tl, th] = wilson(r.agreement, n);
              const [cl, ch] = c ? wilson(c.agreement, n) : [0, 0];

              return (
                <tr key={r.model}>
                  <th scope="row">{name(r.model)}</th>
                  <td>
                    {pct(r.agreement)} <small>({pct(tl)}–{pct(th)})</small> · #{r.rank}
                  </td>
                  <td>
                    {c ? (
                      <>
                        {pct(c.agreement)} <small>({pct(cl)}–{pct(ch)})</small> · #{c.rank}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="proto-fine">Table 1. Same answers, two keys. Ranks change; no answer does.</p>

        <h3>Open models asked the same questions</h3>
        <table className="proto-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Agrees with teacher (95% CI)</th>
              <th scope="col">Decisions</th>
            </tr>
          </thead>
          <tbody>
            {(open?.typed ?? []).map((r) => {
              const [lo, hi] = wilson(r.agreement, r.decisions);

              return (
                <tr key={r.id}>
                  <th scope="row">{r.name}</th>
                  <td>
                    {pct(r.agreement)} <small>({pct(lo)}–{pct(hi)})</small>
                  </td>
                  <td>{r.decisions.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="proto-fine">Table 2. From the Open decisions recordings (SGLang /v1/decisions on an L4, and an MLX port on a laptop).</p>
      </section>

      <section>
        <h2>3. Limits</h2>
        <ul>
          <li>The teacher is itself a small model; agreeing with it is not correctness.</li>
          <li>Intervals treat questions as independent; five questions share each case.</li>
          <li>Open models here are 4-bit or 8-bit and much smaller than SGLang's own Qwen3.8-27B.</li>
        </ul>
      </section>

      <section>
        <h2>4. Data</h2>
        <p>
          <a href="/data/local-models.json" download>
            local-models.json
          </a>{" "}
          ·{" "}
          <a href="/open-decisions/open-decisions.json" download>
            open-decisions.json
          </a>
        </p>
      </section>

      <section className="proto-companion">
        <h2>Companion: re-grade it yourself</h2>
        <p>Pick the key and watch the ranking move. The toy reads the same recording as the tables above.</p>
        {toy ? (
          local && <AnswerKey result={local} />
        ) : (
          <button type="button" className="proto-cta" onClick={() => setToy(true)}>
            Open the toy
          </button>
        )}
      </section>
    </article>
  );
}

/* ----------------------------- 3. Game + evidence drawer ----------------------------- */

function Game() {
  const [drawer, setDrawer] = useState<"method" | "results" | "data" | "caveats" | null>(null);
  const events = ["heatwave", "net", "storm", "bloom", "oil"] as const;

  return (
    <div className="proto-game toybox">
      <header className="proto-game-head">
        <h1>The reef</h1>
        <p>Heat the water. See who makes it.</p>
        <button type="button" className="proto-evidence-btn" onClick={() => setDrawer("results")} aria-expanded={drawer !== null}>
          Evidence
        </button>
      </header>

      <OceanReef />

      <HeadlineStrip id="ocean" title="The reef" />

      {drawer && (
        <div className="proto-drawer-backdrop" onClick={() => setDrawer(null)}>
          <aside className="proto-drawer" role="dialog" aria-label="Evidence" onClick={(e) => e.stopPropagation()}>
            <div className="proto-drawer-tabs" role="tablist">
              {(["results", "method", "data", "caveats"] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={drawer === t} onClick={() => setDrawer(t)}>
                  {t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
              <button type="button" className="proto-drawer-close" onClick={() => setDrawer(null)} aria-label="Close evidence">
                ✕
              </button>
            </div>

            {drawer === "results" && (
              <>
                <p className="proto-fine">{heldout.protocol}</p>
                <table className="proto-table">
                  <thead>
                    <tr>
                      <th scope="col">Decider</th>
                      {events.map((e) => (
                        <th scope="col" key={e}>
                          {e}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {heldout.table.map((row) => (
                      <tr key={row.decider}>
                        <th scope="row">{row.decider}</th>
                        {events.map((e) => {
                          const s = (row.byEvent as Record<string, { survival: number; survivalSd: number } | undefined>)[e];

                          return <td key={e}>{s ? `${pct(s.survival, 0)} ± ${(s.survivalSd * 100).toFixed(0)}` : "—"}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="proto-fine">Share of the event's fish that survived, mean ± sd over {heldout.seeds} unseen seeds.</p>
              </>
            )}
            {drawer === "method" && (
              <p>
                Each small fish chooses its next action from what it can see. The default decider is a 257-weight network evolved
                on survival in this reef only, never on any model's answers. MobileBERT and Jev are alternatives; the race
                replays one recorded Jev run.
              </p>
            )}
            {drawer === "data" && (
              <p>
                <a href="https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/live-worlds/ocean" target="_blank" rel="noreferrer">
                  live-worlds/ocean
                </a>{" "}
                holds the engine, the policy weights, the held-out table and the recorded Jev run.
              </p>
            )}
            {drawer === "caveats" && (
              <ul>
                <li>A short hand-written rule still beats the evolved policy on heatwaves, nets and oil.</li>
                <li>Held to 5 decisions a second, the policy keeps fewer fish than nobody deciding in a heatwave.</li>
                <li>The Jev comparison is one recorded run.</li>
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
