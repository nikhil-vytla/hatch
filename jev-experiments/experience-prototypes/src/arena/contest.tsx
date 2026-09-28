/**
 * Write a contestant: a visitor writes one function that answers One box's questions, runs it
 * in their browser on the 150 public development phrases under the same rules as every
 * recorded contestant, and sees where it beats or trails Jev. Sealed scoring on phrases nobody
 * has seen needs a server run and is not here yet; the page says so.
 */
import { useEffect, useRef, useState } from "react";
import {
  oneBoxPhrasesSchema,
  predsSchema,
  targetsSchema,
  type OneBoxPhrases,
} from "../../../packages/arena/src/data/chunks";
import {
  BUDGET_MS,
  logScore,
  pairedGain,
  type EntryRun,
} from "../../../packages/arena/src/contest/one-box";
import type { SealedScore } from "../../../packages/arena/src/contest/sealed";
import { readResponse } from "../api";
import { loadChunk } from "./data";
import { colorVars, type CardModel } from "./model";

const STARTER = `// Answer One box's 14 questions for the text typed so far.
// Return a distribution per question: weights for a choice, P(yes) for a yes/no.
// Anything missing becomes a uniform guess. You have ${BUDGET_MS} ms per keystroke.
export function answer(state, questions) {
  const t = state.text.toLowerCase();
  const intent = { note: 1, none: t.length < 4 ? 5 : 0.5 };

  if (/remind|don't forget/.test(t)) intent.reminder = 8;
  if (/dinner|lunch|meet|call|zoom|\\d(am|pm)/.test(t)) intent.event = 4;
  if (/split|between|each/.test(t) && /\\$|\\d/.test(t)) intent.split = 6;
  if (/every (day|week|morning)|daily/.test(t)) intent.habit = 6;
  if (/days until|till/.test(t)) intent.countdown = 6;

  return { intent, isQuestion: t.endsWith("?") ? 0.9 : 0.1 };
}
`;

/** The four contestants to beat, in order. */
const BOSSES = ["code.keyword", "tiny@cancel", "laya@cancel", "jev@cancel"];

type Result = { ok: true; run: EntryRun; ms: number } | { ok: false; error: string };

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function Contest({ model: m }: { model: CardModel }) {
  const [code, setCode] = useState(STARTER);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [dev, setDev] = useState<OneBoxPhrases["phrases"] | null>(null);
  const [jevScores, setJevScores] = useState<Map<string, number> | null>(null);
  const worker = useRef<Worker | null>(null);

  const [sealed, setSealed] = useState<{ busy: boolean; score?: SealedScore; error?: string }>({
    busy: false,
  });

  /** Sends the code (never the phrases, which only the server holds) for one sealed run. */
  const submit = async () => {
    setSealed({ busy: true });

    try {
      const response = await fetch("/api/contest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      const body: SealedScore & { error?: string } = await readResponse(response);

      setSealed(response.ok ? { busy: false, score: body } : { busy: false, error: body.error });
    } catch (error) {
      setSealed({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const { phrases: phrasesPath, targets: targetsPath, preds } = m.card.chunks;

  useEffect(() => {
    if (!phrasesPath || !targetsPath || !preds?.["jev@cancel"]) return;
    let alive = true;

    void (async () => {
      const [ph, targets, jev] = await Promise.all([
        loadChunk(phrasesPath, oneBoxPhrasesSchema),
        loadChunk(targetsPath, targetsSchema),
        loadChunk(preds["jev@cancel"], predsSchema),
      ]);

      // Jev's log score on each phrase's finished text, from its recorded distribution.
      const scores = new Map<string, number>();

      ph.phrases.forEach((p, i) => {
        const row = targets.rows.findIndex((r) => r.c === i);
        const dist = row >= 0 ? jev.p[row] : undefined;

        if (!dist) return;
        const sum = dist.reduce((a, b) => a + b, 0) || 1;
        const named = Object.fromEntries(targets.rows[row].keys.map((k, j) => [k, dist[j] / sum]));

        scores.set(p.id, logScore(named, p));
      });

      if (!alive) return;
      setDev(ph.phrases.filter((p) => p.split === "development"));
      setJevScores(scores);
    })();

    return () => {
      alive = false;
    };
  }, [phrasesPath, targetsPath, preds]);

  useEffect(() => () => worker.current?.terminate(), []);

  const run = () => {
    if (!dev) return;
    worker.current?.terminate();
    const w = new Worker(new URL("./contest-worker.ts", import.meta.url), { type: "module" });
    const started = performance.now();

    // A run that hangs is stopped, not waited on.
    const limit = setTimeout(() => {
      w.terminate();
      setRunning(false);
      setResult({ ok: false, error: "Stopped after 60 s. Make answer() faster." });
    }, 60_000);

    worker.current = w;
    setRunning(true);
    setResult(null);

    w.onmessage = (e: MessageEvent<{ ok: true; run: EntryRun } | { ok: false; error: string }>) => {
      clearTimeout(limit);
      w.terminate();
      setRunning(false);
      setResult(
        e.data.ok ? { ok: true, run: e.data.run, ms: performance.now() - started } : e.data,
      );
    };

    w.postMessage({
      code,
      policy: "cancel",
      phrases: dev.map((p) => ({
        id: p.id,
        text: p.text,
        intent: p.intent,
        acceptable: p.acceptable,
      })),
    });
  };

  const devSlice = m.card.slices?.workflow?.development ?? {};

  const yours = (() => {
    if (!result?.ok || !dev) return null;
    const ps = result.run.phrases;
    const byId = new Map(dev.map((p) => [p.id, p]));
    const right = ps.filter((p) => p.outcome.finalRight).length / ps.length;
    const mine = ps.map((p) => logScore(p.final, byId.get(p.id) ?? { intent: "none" }));
    const theirs = ps.map((p) => jevScores?.get(p.id) ?? Math.log(0.001));

    const diffs = ps
      .map((p, i) => ({ p: byId.get(p.id), gain: mine[i] - theirs[i], you: p.outcome.finalRight }))
      .sort((a, b) => b.gain - a.gain);

    return {
      right,
      wrong: ps.reduce((s, p) => s + p.outcome.wrongCommits, 0) / ps.length,
      changes: ps.reduce((s, p) => s + p.outcome.changes, 0) / ps.length,
      gain: pairedGain(mine, theirs),
      best: diffs.slice(0, 3),
      worst: diffs.slice(-3).reverse(),
    };
  })();

  return (
    <div className="ct">
      <p className="ob-try-rules muted small">
        Your function runs in your browser, with network access removed, on the 150 public
        development phrases: every keystroke, the same calm rules, {BUDGET_MS} ms per keystroke (a
        slower answer doesn't land for that keystroke). Scores are the same ones every contestant
        gets. When it runs, you can submit it once for scoring on sealed phrases: the server runs
        your code in a sandbox and returns only totals.
      </p>
      <label className="ct-editor">
        <span className="sr-only">Your contestant</span>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          rows={18}
        />
      </label>
      <div className="watch-controls" role="group" aria-label="Run controls">
        <button type="button" className="primary" onClick={run} disabled={running || !dev}>
          {running ? "Running…" : "Run on the 150 practice phrases"}
        </button>
        <button type="button" onClick={() => setCode(STARTER)}>
          Reset to the starter
        </button>
        <button type="button" onClick={() => void submit()} disabled={sealed.busy || !result?.ok}>
          {sealed.busy ? "Scoring on sealed phrases…" : "Submit for sealed scoring"}
        </button>
        {result?.ok && (
          <span className="watch-clock">
            {result.run.calls} calls · median {result.run.medianMs.toFixed(2)} ms ·{" "}
            {result.run.late} late · {result.run.errors} errors
          </span>
        )}
      </div>

      <div role="status" aria-live="polite">
        {sealed.error && <p className="notice">{sealed.error}</p>}
        {sealed.score && (
          <p className="finding">
            Sealed phrases ({sealed.score.phrases} nobody outside the scorer has seen): your box
            ends right on {pct(sealed.score.boxRight)}, Jev's on {pct(sealed.score.jevBoxRight)}.
            Against Jev on the finished phrase: {sealed.score.gainOverJev.mean >= 0 ? "+" : ""}
            {sealed.score.gainOverJev.mean.toFixed(3)} ± {sealed.score.gainOverJev.half.toFixed(3)}.
          </p>
        )}
        {result && !result.ok && <p className="notice">{result.error}</p>}
        {result?.ok && result.run.errors > 0 && (
          <p className="notice">
            {result.run.errors} of {result.run.calls} calls threw an error and counted as no answer.
            The first: “{result.run.firstError}”. Network access isn't available to contestants.
          </p>
        )}
        {yours && (
          <>
            <table className="results ct-table">
              <thead>
                <tr>
                  <th scope="col">Contestant</th>
                  <th scope="col">Box ends right</th>
                  <th scope="col">Wrong commits / phrase</th>
                  <th scope="col">Changes / phrase</th>
                </tr>
              </thead>
              <tbody>
                <tr className="ct-you">
                  <th scope="row">You</th>
                  <td>{pct(yours.right)}</td>
                  <td>{yours.wrong.toFixed(2)}</td>
                  <td>{yours.changes.toFixed(2)}</td>
                </tr>
                {BOSSES.map((id) => {
                  const r = devSlice[id];
                  const right = r?.right?.value;
                  const beat = right !== undefined && yours.right > right;

                  return (
                    <tr key={id} style={colorVars(m.contestant(id))}>
                      <th scope="row">
                        <span className="swatch" aria-hidden="true" /> {m.label(id)}{" "}
                        <span className="muted small">{beat ? "· beaten" : ""}</span>
                      </th>
                      <td>{right === undefined ? "—" : pct(right)}</td>
                      <td>{r?.wrong?.value.toFixed(2) ?? "—"}</td>
                      <td>{r?.changes?.value.toFixed(2) ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="finding">
              Against Jev on the finished phrase (log score per phrase, probabilities clamped to
              1–99%): {yours.gain.mean >= 0 ? "+" : ""}
              {yours.gain.mean.toFixed(3)} ± {yours.gain.half.toFixed(3)}.{" "}
              {Math.abs(yours.gain.mean) <= yours.gain.half
                ? "Not a clear difference yet."
                : yours.gain.mean > 0
                  ? "You beat Jev here, clearly."
                  : "Jev is clearly ahead."}
            </p>
            <div className="ct-diffs">
              <div>
                <h3 className="kicker">Your best phrases against Jev</h3>
                <ul>
                  {yours.best.map((d) => (
                    <li key={d.p?.id}>
                      “{d.p?.text}”{" "}
                      <span className="muted">
                        ({d.gain >= 0 ? "+" : ""}
                        {d.gain.toFixed(2)})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="kicker">Your worst phrases against Jev</h3>
                <ul>
                  {yours.worst.map((d) => (
                    <li key={d.p?.id}>
                      “{d.p?.text}” <span className="muted">({d.gain.toFixed(2)})</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
