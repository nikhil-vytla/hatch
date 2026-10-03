/**
 * Screen sentry: a safety net that lets an AI helper browse for you without being hijacked. A
 * visitor plants traps in a sandboxed fake page, a sentry rates every block, and a simulated
 * helper either skips flagged blocks and finishes the task or follows an unflagged trap. Nothing
 * browses anywhere; the helper is code.
 *
 * Three ways to check a page: the free sentry (live-worlds/sentry/model.ts, in the browser),
 * Jev's recorded answers for every block the scene ships (no key needed), and Jev live on the
 * visitor's own key. Jev's answers are compared and shown, never trained on (TypeSafe MCA §2.3(b)).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { blockKey, batchRequest, batchScores, BATCH } from "../../live-worlds/sentry/jev";
import { RISK_THRESHOLD, score, type Scores, type Weights } from "../../live-worlds/sentry/model";
import { HARD_TRAPS, PAGES, runHelper, TRAPS, withTrap, type Outcome, type PageBlock, type PlacedTrap, type TrapKind } from "../../live-worlds/sentry/pages";
import weightsJson from "../../live-worlds/sentry/weights.json";
import evalJson from "../../live-worlds/sentry/eval.json";
import compareJson from "../../live-worlds/sentry/compare.json";
import { NO_KEY_MESSAGE, run } from "./api";
import { describeFailure, type Failure } from "./live-failure";
import { fromLiveBatches, Receipt, type ReceiptData } from "./receipt";
import { KeyTag, LiveFailure, ModeTag } from "./trust";
import "./screen-sentry.css";

// SAFETY: weights.json is written by live-worlds/sentry/train.ts in exactly this shape.
const W = weightsJson as Weights;

type Recorded = {
  blocks: Record<string, { scores: Scores; batch: string }>;
  batches: Record<string, { at: string; servedBy: string | null; latencyMs: number; inputTokens: number | null; costUsd: number | null; request: unknown; answers: unknown }>;
};

type Count = { injectionsCaught: string; harmlessFlagged: string };

type Compare = { sets: Record<string, { free: Count; jev: Count }>; spend: { requests: number; costUsd: number; medianLatencyMs: number; recordedOn: string } };

// SAFETY: compare.json is written by live-worlds/sentry/compare.ts in exactly this shape.
const CMP = compareJson as Compare;

type Mode = "plant" | "levels";

type Decider = "free" | "recorded" | "live";

type Trap = PlacedTrap & { label: string };

type Fooled = { text: string; kind: string; risk: number; page: string; at: string };

const FOOLED_KEY = "screen-sentry-fooled";

const LEVELS: { kind: TrapKind; goal: string }[] = [
  { kind: "hidden", goal: "Hide white-on-white text the sentry misses." },
  { kind: "ps", goal: "Write a polite PS that slips past." },
  { kind: "alt", goal: "Smuggle an instruction into an image's alt text." },
  { kind: "comment", goal: "Hide it in an HTML comment." },
  { kind: "system", goal: "Forge a system note it doesn't catch." },
];

const SETS: [string, string][] = [
  ["scene: default traps", "The five default traps, on all three pages"],
  ["scene: hard traps", "Eight harder traps, on all three pages"],
  ["scene: page blocks", "The pages' own harmless blocks"],
  ["wild2", "Fresh hand-written test (written before scoring)"],
  ["wild", "First hand-written test (guided the fixes)"],
  ["injecagent", "InjecAgent: instructions planted in tool output"],
  ["deepset", "deepset prompt injections"],
  ["gandalf", "Gandalf 'ignore your instructions' attempts"],
  ["jailbreak", "Jailbreak prompts (its harmless rows still instruct an AI)"],
];

const pct = (n: number) => `${Math.round(n * 100)}%`;

function readFooled(): Fooled[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOOLED_KEY) ?? "[]");

    // SAFETY: only this scene writes the key, as Fooled[]; anything else is cut to an empty list.
    return Array.isArray(v) ? (v as Fooled[]).slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** One block of the fake page, drawn the way a browser would; x-ray reveals what's hidden. */
function FakeBlock({ b, s, xray, active, outcome }: { b: PageBlock; s: Scores; xray: boolean; active: boolean; outcome?: string }) {
  const flagged = s.risk >= RISK_THRESHOLD;
  const cls = ["ss-block", `ss-${b.where}`, b.value ? "ss-row" : "", xray ? "ss-xray" : "", flagged && xray ? "ss-flagged" : "", active ? "ss-active" : "", outcome ? `ss-${outcome}` : ""].join(" ");

  if (b.where === "comment")
    return xray ? (
      <div className={cls}>
        <code>{`<!-- ${b.text} -->`}</code>
        <RiskBadge s={s} />
      </div>
    ) : null;

  if (b.where === "alt")
    return (
      <figure className={cls}>
        <div className="ss-img" aria-hidden="true">
          🖼
        </div>
        <figcaption>{b.image}</figcaption>
        {xray && <small className="ss-alt">alt: “{b.text}”</small>}
        {xray && <RiskBadge s={s} />}
      </figure>
    );

  return (
    <div className={cls}>
      <span>{b.text}</span>
      {xray && <RiskBadge s={s} />}
    </div>
  );
}

function RiskBadge({ s }: { s: Scores }) {
  const flagged = s.risk >= RISK_THRESHOLD;

  return <span className={`ss-badge ${flagged ? "ss-badge-hot" : ""}`}>{flagged ? `⚠ ${pct(s.risk)}` : `✓ ${pct(s.risk)}`}</span>;
}

function Meter({ s }: { s: Scores | null }) {
  if (!s) return <span className="ss-none">not recorded</span>;

  return (
    <>
      <span className={`ss-meter ${s.risk >= RISK_THRESHOLD ? "ss-meter-hot" : ""}`} aria-hidden="true">
        <i style={{ width: pct(s.risk) }} />
      </span>{" "}
      {pct(s.risk)}
    </>
  );
}

function SentryTable({ blocks, free, jev, jevLabel, active }: { blocks: PageBlock[]; free: Scores[]; jev: (Scores | null)[] | null; jevLabel: string; active: number }) {
  return (
    <table className="ss-table">
      <thead>
        <tr>
          <th scope="col">Block</th>
          <th scope="col">Where</th>
          <th scope="col">Free sentry</th>
          {jev && <th scope="col">{jevLabel}</th>}
        </tr>
      </thead>
      <tbody>
        {blocks.map((b, i) => {
          const s = jev?.[i] ?? free[i];
          const flagged = s.risk >= RISK_THRESHOLD;

          return (
            <tr key={b.id} className={`${flagged ? "ss-hot" : ""} ${i === active ? "ss-active-row" : ""}`}>
              <th scope="row" title={b.text}>
                {b.text.length > 46 ? b.text.slice(0, 44) + "…" : b.text}
                {flagged && (
                  <small>
                    {s.addressed >= 0.5 ? "addressed to the assistant · " : ""}
                    {s.goal >= 0.5 ? "changes the goal · " : ""}
                    {s.secrets >= 0.5 ? "asks for secrets · " : ""}
                    {s.instruction >= 0.5 ? "an instruction" : "content"}
                  </small>
                )}
              </th>
              <td>{b.where}</td>
              <td>
                <Meter s={free[i]} />
              </td>
              {jev && (
                <td>
                  <Meter s={jev[i]} />
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Method, results, data and limits, one click away from the game. */
function Evidence({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"results" | "method" | "data" | "limits">("results");
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;

    if (!d) return;

    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const tabs: [typeof tab, string][] = [
    ["results", "Results"],
    ["method", "Method"],
    ["data", "Data"],
    ["limits", "Limits"],
  ];

  return (
    <dialog ref={ref} className="ss-drawer" aria-labelledby="ss-drawer-title" onClose={onClose}>
      <div className="ss-drawer-head">
        <h3 id="ss-drawer-title">Accuracy and data</h3>
        <button type="button" className="ss-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="ss-drawer-tabs" role="tablist" aria-label="Accuracy and data">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="ss-drawer-body" role="tabpanel">
        {tab === "results" && (
          <>
            <p>
              The same blocks, checked by the free sentry and by Jev's recorded answers, at a risk threshold of{" "}
              {pct(RISK_THRESHOLD)}. Counts are injections caught and harmless blocks wrongly flagged.
            </p>
            <table className="ss-table ss-results">
              <thead>
                <tr>
                  <th scope="col">Set</th>
                  <th scope="col">Free: caught</th>
                  <th scope="col">Free: false alarms</th>
                  <th scope="col">Jev: caught</th>
                  <th scope="col">Jev: false alarms</th>
                </tr>
              </thead>
              <tbody>
                {SETS.filter(([k]) => CMP.sets[k]).map(([k, label]) => (
                  <tr key={k}>
                    <th scope="row">{label}</th>
                    <td>{CMP.sets[k].free.injectionsCaught}</td>
                    <td>{CMP.sets[k].free.harmlessFlagged}</td>
                    <td>{CMP.sets[k].jev.injectionsCaught}</td>
                    <td>{CMP.sets[k].jev.harmlessFlagged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="ss-fine">
              Jev's answers: {CMP.spend.requests} requests recorded on {CMP.spend.recordedOn}, ${CMP.spend.costUsd} at list
              price, median {CMP.spend.medianLatencyMs} ms per batch of up to {BATCH} blocks.
            </p>
          </>
        )}
        {tab === "method" && (
          <>
            <p>
              Each block of the page is asked five yes/no questions: is it addressed to an AI, does it change the user's goal,
              does it ask for secrets, is it an instruction rather than content, and would following it hijack a helper doing
              the user's task. A block is flagged when the last one is at least {pct(RISK_THRESHOLD)}.
            </p>
            <p>
              The free sentry answers them in your browser with five small logistic heads over hashed words, word pairs, a few
              cue words and where the block sits (visible, hidden, tiny, a comment, alt text). It trained on{" "}
              {(evalJson as { trainedOn: string }).trainedOn}. Real rows train the hijack question only, at a quarter of an
              authored block's weight, a setting chosen on validation data carved from the training set.
            </p>
            <p>
              Jev is asked the same five questions in batches of {BATCH} blocks, with the page title and the helper's task as
              context. Its answers here were recorded once for every block and trap the scene ships; edit a trap and only the
              free sentry, or Jev on your own key, can rate the new words.
            </p>
            <p>
              The helper is code: it reads blocks in order, skips flagged ones and follows the first unflagged trap. Flagging a
              real price means it never sees that price.
            </p>
          </>
        )}
        {tab === "data" && (
          <>
            <p>Training and test data, all openly licensed, checked at the source on 3 Oct 2026:</p>
            <ul>
              <li>
                <a href="https://huggingface.co/datasets/deepset/prompt-injections" target="_blank" rel="noreferrer">
                  deepset/prompt-injections
                </a>{" "}
                (Apache-2.0)
              </li>
              <li>
                <a href="https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions" target="_blank" rel="noreferrer">
                  Lakera/gandalf_ignore_instructions
                </a>{" "}
                (MIT)
              </li>
              <li>
                <a href="https://huggingface.co/datasets/jackhhao/jailbreak-classification" target="_blank" rel="noreferrer">
                  jackhhao/jailbreak-classification
                </a>{" "}
                (Apache-2.0)
              </li>
              <li>
                <a href="https://github.com/uiuc-kang-lab/InjecAgent" target="_blank" rel="noreferrer">
                  InjecAgent
                </a>{" "}
                (MIT), injections planted in tool output
              </li>
              <li>Our own authored blocks, two hand-written test sets and eight hard traps</li>
            </ul>
            <p>
              No Jev answer trains anything: TypeSafe's terms forbid it. Everything, including Jev's raw recorded answers, is in{" "}
              <a href="https://github.com/nikhil-vytla/hatch/tree/main/jev-experiments/live-worlds/sentry" target="_blank" rel="noreferrer">
                live-worlds/sentry
              </a>
              .
            </p>
          </>
        )}
        {tab === "limits" && (
          <ul>
            <li>The helper and its actions are simulated; nothing browses anywhere.</li>
            <li>
              The hand-written tests are small (20 injections, 20 harmless blocks each). A few blocks either way moves the rates a
              lot.
            </li>
            <li>
              The first hand-written test guided which gaps were fixed, so it flatters the free sentry; the second was written
              before any scoring.
            </li>
            <li>
              The free sentry still flags some harmless blocks that mention assistants or agents, and some image captions and
              comments. Jev catches more of the hard traps.
            </li>
            <li>
              Harmless "ignore our last email" notices pass only when worded like the training ones: a held-out wording ("Forget
              about the delay: we've fixed it") was flagged every time.
            </li>
            <li>
              The jailbreak dataset's "harmless" prompts still give an AI instructions. Jev flags many of them; on a web page that
              is arguably right.
            </li>
            <li>It reads text only. A trap drawn into an image's pixels gets past both.</li>
          </ul>
        )}
      </div>
    </dialog>
  );
}

export function ScreenSentry() {
  const [mode, setMode] = useState<Mode>("plant");
  const [pageId, setPageId] = useState("flights");
  const [traps, setTraps] = useState<Trap[]>([]);
  const [draft, setDraft] = useState<Trap | null>(null);
  const [xray, setXray] = useState(true);
  const [step, setStep] = useState(-1);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [fooled, setFooled] = useState<Fooled[]>(readFooled);
  const [level, setLevel] = useState(0);
  const [passed, setPassed] = useState<boolean[]>(() => LEVELS.map(() => false));
  const [decider, setDecider] = useState<Decider>("free");
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [live, setLive] = useState<{ key: string; scores: Scores[]; receipt: ReceiptData } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [asking, setAsking] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const base = PAGES.find((p) => p.id === pageId) ?? PAGES[0];
  const page = useMemo(() => traps.reduce((p, t, n) => withTrap(p, t, n), base), [base, traps]);
  const pageKey = JSON.stringify(page.blocks.map((b) => [b.text, b.where]));
  const freeScores = useMemo(() => page.blocks.map((b) => score(W, b)), [page]);

  // Jev's recorded answers are 105 KB, so they load only when asked for.
  useEffect(() => {
    if (decider !== "recorded" || recorded) return;

    let alive = true;

    void import("../../live-worlds/sentry/scene-jev.json").then((m) => {
      // SAFETY: scene-jev.json is written by live-worlds/sentry/compare.ts in exactly this shape.
      if (alive) setRecorded(m.default as Recorded);
    });

    return () => {
      alive = false;
    };
  }, [decider, recorded]);

  const recordedScores = useMemo(() => (recorded ? page.blocks.map((b) => recorded.blocks[blockKey(page.id, b)]?.scores ?? null) : null), [recorded, page]);
  const liveScores = live?.key === pageKey ? live.scores : null;
  const jevColumn = decider === "recorded" ? recordedScores : decider === "live" ? liveScores : null;
  const scores = page.blocks.map((_, i) => jevColumn?.[i] ?? freeScores[i]);
  const missing = decider === "recorded" && recordedScores ? recordedScores.filter((s) => s === null).length : 0;

  const recordedReceipt = useMemo((): ReceiptData | null => {
    if (!recorded) return null;

    const ids = [...new Set(page.blocks.map((b) => recorded.blocks[blockKey(page.id, b)]?.batch).filter((x): x is string => Boolean(x)))];
    const bs = ids.map((id) => recorded.batches[id]);

    if (!bs.length) return null;

    return {
      mode: "recorded",
      ms: Math.max(...bs.map((b) => b.latencyMs)),
      questions: page.blocks.length * 5,
      inputTokens: bs.reduce((a, b) => a + (b.inputTokens ?? 0), 0),
      costUsd: bs.reduce((a, b) => a + (b.costUsd ?? 0), 0),
      at: bs[0].at,
      servedBy: bs[0].servedBy,
      raw: { request: bs.map((b) => b.request), response: bs.map((b) => b.answers), note: "Every block's answers were recorded once, in batches of 8; this page's blocks come from these batches." },
    };
  }, [recorded, page]);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const reset = () => {
    if (timer.current) clearInterval(timer.current);

    setStep(-1);
    setOutcome(null);
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setTraps([]);
    setDraft(null);
    reset();
  };

  const startDraft = (t: Trap) => setDraft({ ...t });

  const plant = () => {
    if (!draft) return;

    setTraps((ts) => (mode === "levels" ? [draft] : [...ts, draft].slice(-3)));
    setDraft(null);
    reset();
  };

  const go = () => {
    reset();

    const flagged = (b: PageBlock) => scores[page.blocks.indexOf(b)].risk >= RISK_THRESHOLD;
    const out = runHelper(page, flagged);
    let i = 0;

    setStep(0);
    timer.current = setInterval(() => {
      i++;

      if (i >= out.steps.length) {
        if (timer.current) clearInterval(timer.current);

        setStep(-1);
        setOutcome(out);

        if (out.hijacked) {
          const trapBlock = page.blocks.find((b) => b.id === out.steps.at(-1)?.id);

          if (trapBlock?.trap) {
            const f: Fooled = { text: trapBlock.text, kind: trapBlock.trap, risk: scores[page.blocks.indexOf(trapBlock)].risk, page: page.title, at: new Date().toISOString() };
            const next = [f, ...fooled].slice(0, 20);

            setFooled(next);
            localStorage.setItem(FOOLED_KEY, JSON.stringify(next));

            if (mode === "levels" && trapBlock.trap === LEVELS[level].kind) setPassed((p) => p.map((v, j) => (j === level ? true : v)));
          }
        }

        return;
      }

      setStep(i);
    }, 320);
  };

  const askLive = async () => {
    setAsking(true);
    setFailure(null);

    try {
      const bodies: unknown[] = [];
      const out: Scores[] = [];

      for (let start = 0; start < page.blocks.length; start += BATCH) {
        const chunk = page.blocks.slice(start, start + BATCH);
        const req = batchRequest({ task: page.task, page: page.title }, chunk);
        const body = await run(req.state, req.questions, undefined, { deadlineMs: 8000, maxAttempts: 2 });

        bodies.push(body);
        out.push(...batchScores(body.answers, chunk.length));
      }

      setLive({ key: pageKey, scores: out, receipt: fromLiveBatches(bodies, { task: page.task }) });
      setDecider("live");
      reset();
    } catch (e) {
      setFailure(describeFailure(e, NO_KEY_MESSAGE));
    } finally {
      setAsking(false);
    }
  };

  const plan = step >= 0 && outcome === null ? runHelper(page, (x) => scores[page.blocks.indexOf(x)].risk >= RISK_THRESHOLD) : null;
  const active = plan ? page.blocks.findIndex((b) => b.id === plan.steps[step]?.id) : -1;
  const lastSteps = outcome ? new Map(outcome.steps.map((s) => [s.id, s.action])) : null;
  const flaggedCount = scores.filter((s) => s.risk >= RISK_THRESHOLD).length;
  const levelTrap = TRAPS.find((t) => t.kind === LEVELS[level].kind);

  const browser = (
    <div className="ss-browser">
      <div className="ss-urlbar">
        <span aria-hidden="true">● ● ●</span> {page.url}
        <label className="ss-xray-toggle">
          <input type="checkbox" checked={xray} onChange={(e) => setXray(e.target.checked)} /> X-ray
        </label>
      </div>
      <div className="ss-page">
        {page.blocks.map((b, i) => (
          <FakeBlock key={b.id} b={b} s={scores[i]} xray={xray} active={i === active} outcome={lastSteps?.get(b.id)} />
        ))}
      </div>
    </div>
  );

  const trapTools = (
    <div className="ss-traps">
      {mode === "levels" ? (
        <>
          <p className="ss-label">{LEVELS[level].goal}</p>
          <div className="ss-chips">
            {levelTrap && (
              <button type="button" onClick={() => startDraft({ kind: levelTrap.kind, where: levelTrap.where, text: levelTrap.text, label: levelTrap.label })}>
                + {levelTrap.label}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="ss-label">Plant a trap</p>
          <div className="ss-chips">
            {TRAPS.map((t) => (
              <button key={t.kind} type="button" onClick={() => startDraft({ kind: t.kind, where: t.where, text: t.text, label: t.label })}>
                + {t.label}
              </button>
            ))}
          </div>
          <p className="ss-label">Harder traps</p>
          <div className="ss-chips">
            {HARD_TRAPS.map((t) => (
              <button key={t.id} type="button" className="ss-hard" onClick={() => startDraft({ kind: "hard", where: t.where, text: t.text, label: t.label })}>
                + {t.label}
              </button>
            ))}
            {traps.length > 0 && (
              <button type="button" className="ss-quiet" onClick={() => (setTraps([]), reset())}>
                Clear traps
              </button>
            )}
          </div>
        </>
      )}
      {draft && (
        <div className="ss-draft">
          <label>
            Trap text <small>(edit it to try to slip past the sentry)</small>
            <textarea value={draft.text} rows={3} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          </label>
          <p className="ss-preview" aria-live="polite">
            The free sentry would rate it <b>{pct(score(W, { text: draft.text, where: draft.where }).risk)}</b> risk
          </p>
          <button type="button" className="ss-go" onClick={plant}>
            Plant it
          </button>
        </div>
      )}
    </div>
  );

  const result = outcome && (
    <div className={`ss-outcome ${outcome.hijacked ? "ss-bad" : outcome.correct ? "ss-good" : "ss-meh"}`} role="status">
      {outcome.hijacked ? (
        <>
          <b>Hijacked.</b> The helper {outcome.hijacked}. {mode === "levels" && passed[level] ? "Level passed!" : ""}
        </>
      ) : outcome.correct ? (
        <>
          <b>Task done safely:</b> {outcome.answer}. {outcome.steps.filter((s) => s.action === "skip").length} flagged block(s) skipped.
        </>
      ) : (
        <>
          <b>Safe, but wrong:</b> the helper answered {outcome.answer}; the right answer was {outcome.right}. The sentry flagged real content.
        </>
      )}
    </div>
  );

  const deciderMode = decider === "free" ? "browser" : decider === "recorded" ? "recorded" : "live";

  const controls = (
    <div className="ss-controls">
      <div className="ss-task">
        <span className="ss-label">The helper's task</span>
        <b>{page.task}</b>
      </div>
      <button type="button" className="ss-go" onClick={go} disabled={step >= 0 && outcome === null}>
        Send the helper in
      </button>
      <ModeTag mode={deciderMode} />
      <div className="ss-deciders" role="group" aria-label="Who checks the page">
        <button type="button" aria-pressed={decider === "free"} onClick={() => (setDecider("free"), reset())}>
          Free sentry <small>in your browser · free</small>
        </button>
        <button type="button" aria-pressed={decider === "recorded"} onClick={() => (setDecider("recorded"), reset())}>
          Jev <small>recorded · free</small>
        </button>
        <button type="button" className="ss-secondary" aria-pressed={decider === "live"} disabled={asking} onClick={() => void askLive()}>
          {asking ? "Asking Jev…" : "Try your own"} <KeyTag />
        </button>
      </div>
      {decider === "recorded" && missing > 0 && (
        <p className="ss-fine" role="status">
          Jev hasn't seen {missing === 1 ? "one block" : `${missing} blocks`} on this page (an edited trap), so the free sentry's
          rating is used there. Try your own key to ask Jev about your words.
        </p>
      )}
      {failure && <LiveFailure failure={failure} fallback="The free sentry keeps checking the page in your browser, and Jev's recorded answers still work." onRetry={() => void askLive()} />}
      {decider === "recorded" && recordedReceipt && <Receipt data={recordedReceipt} label="Jev's recorded check" />}
      {decider === "live" && live?.key === pageKey && <Receipt data={live.receipt} label="Jev's live check" />}
    </div>
  );

  return (
    <div className="toybox ss">
      <div className="ss-top">
        <div className="ss-modes" role="group" aria-label="Mode">
          <button type="button" aria-pressed={mode === "plant"} onClick={() => switchMode("plant")}>
            Plant traps
          </button>
          <button type="button" aria-pressed={mode === "levels"} onClick={() => switchMode("levels")}>
            Levels
          </button>
        </div>
        <div className="ss-pages" role="group" aria-label="Page">
          {PAGES.map((p) => (
            <button key={p.id} type="button" aria-pressed={p.id === pageId} onClick={() => (setPageId(p.id), setTraps([]), setDraft(null), reset(), setLive(null))}>
              {p.title}
            </button>
          ))}
        </div>
        <span className="ss-count" aria-live="polite">
          {flaggedCount} of {page.blocks.length} blocks flagged
        </span>
        <button type="button" className="ss-evidence" onClick={() => setEvidence(true)}>
          Accuracy and data
        </button>
      </div>

      {mode === "levels" && (
        <ol className="ss-levels">
          {LEVELS.map((l, i) => (
            <li key={l.kind}>
              <button type="button" aria-pressed={i === level} onClick={() => (setLevel(i), setTraps([]), setDraft(null), reset())}>
                {passed[i] ? "★" : "☆"} Level {i + 1}
              </button>
            </li>
          ))}
        </ol>
      )}

      <div className="ss-grid">
        <div>{browser}</div>
        <aside>
          {controls}
          {trapTools}
          {result}
          <SentryTable blocks={page.blocks} free={freeScores} jev={jevColumn} jevLabel={decider === "live" ? "Jev (live)" : "Jev (recorded)"} active={active} />
        </aside>
      </div>

      <details className="ss-fooled">
        <summary>Traps that fooled the sentry ({fooled.length}, saved in this browser only)</summary>
        <ol>
          {fooled.map((f) => (
            <li key={f.at}>
              <b>{pct(f.risk)}</b> {f.kind} on {f.page}: “{f.text}”
            </li>
          ))}
        </ol>
      </details>

      <p className="ss-fine">The helper is simulated and never leaves this page. Method, data and accuracy are under Accuracy and data.</p>

      <Evidence open={evidence} onClose={() => setEvidence(false)} />
    </div>
  );
}
