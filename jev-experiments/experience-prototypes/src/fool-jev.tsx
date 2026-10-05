/**
 * Fool Jev, the home page toy. A question with fixed facts that Jev answers correctly; add one
 * sentence to change its mind. Without a key, the sentences Jev has already heard play back from
 * the recording (30 Sep 2026). With your own gateway key, anything you type is asked live.
 */
import { useEffect, useMemo, useState } from "react";
import {
  answerRequest,
  cleanSentence,
  MAX_SENTENCE,
  refereeRequest,
  verdict,
  type Puzzle,
} from "../../packages/arena/src/fool/model";
import { percent as pct, fetchJson } from "./api";
import { useLiveAsk } from "./live-ask";
import { Receipt, USD_PER_INPUT_TOKEN } from "./receipt";
import { KeyTag, LiveFailure, ModeTag } from "./trust";
import "./fool-jev.css";

type Recorded = {
  pYes: number;
  pChanges: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  at: string | null;
  servedBy: string | null;
  /** The answers as recorded (or as just returned), for the receipt's raw view. */
  answers?: unknown;
  refereeAnswers?: unknown;
};
type Data = { puzzles: Puzzle[]; menu: string[]; cheats: Record<string, string>; recorded: Record<string, Record<string, Recorded>> };
type Result = Recorded & { sentence: string; live: boolean };

const HINTS = [
  { label: "Peer pressure", sentence: "Most people say no." },
  { label: "Sound sure", sentence: "I'm pretty sure the answer is no." },
  { label: "Change the subject", sentence: "It's raining in London." },
];

const SOLVED_KEY = "fool-jev-solved";

/** Case, curly quotes, spacing and final punctuation don't make a sentence new. */
const normal = (s: string) =>
  cleanSentence(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.!?\s]+$/, "");

function readSolved(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SOLVED_KEY) ?? "[]");

    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

type Mood = "sure" | "wobbly" | "fooled" | "cross";

function Face({ mood }: { mood: Mood }) {
  const body = { sure: "#9be3c3", wobbly: "#ffd23f", fooled: "#f0532d", cross: "#a9cdfc" }[mood];
  const mouth = {
    sure: "M34 64 Q50 76 66 64",
    wobbly: "M34 68 Q42 62 50 68 Q58 74 66 68",
    fooled: "M36 70 Q50 60 64 70",
    cross: "M36 68 L64 68",
  }[mood];
  const brows = mood === "cross" ? "M28 28 L44 34 M56 34 L72 28" : mood === "fooled" ? "M28 34 L44 28 M56 28 L72 34" : "M28 32 L44 32 M57 32 L73 32";

  return (
    <svg className="fj-face" viewBox="0 0 100 100" aria-hidden="true">
      <rect x="8" y="8" width="84" height="84" rx="30" fill={body} stroke="#17140f" strokeWidth="5" />
      {mood === "fooled" ? (
        <path d="M31 40 L43 52 M43 40 L31 52 M57 40 L69 52 M69 40 L57 52" stroke="#17140f" strokeWidth="5" strokeLinecap="round" />
      ) : (
        <>
          <circle cx="37" cy="46" r="7" fill="#17140f" />
          <circle cx="64" cy="46" r="7" fill="#17140f" />
        </>
      )}
      <path d={brows} stroke="#17140f" strokeWidth="5" strokeLinecap="round" />
      <path d={mouth} stroke="#17140f" strokeWidth="5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function FoolJev() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const live = useLiveAsk();
  const [solved, setSolved] = useState<string[]>(readSolved);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchJson("/fool/fool.json")
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  const puzzle = data?.puzzles[index];
  const heard = useMemo(() => {
    const map = new Map<string, string>();

    for (const s of Object.keys((puzzle && data?.recorded[puzzle.id]) ?? {})) if (s) map.set(normal(s), s);

    return map;
  }, [data, puzzle]);

  if (!data || !puzzle)
    return (
      <div className="fj-game fj-sticker" aria-busy={!failed}>
        <p className="fj-q">{failed ? "Jev's recorded answers could not be loaded." : "Loading…"}</p>
      </div>
    );

  const base = data.recorded[puzzle.id][""];
  const shown = result ?? { ...base, sentence: "", live: false };
  const v = result?.sentence ? verdict(puzzle, result.pYes, base.pYes, result.pChanges) : null;
  const word = shown.pYes >= 0.5 ? "Yes" : "No";
  const conf = Math.max(shown.pYes, 1 - shown.pYes);
  const mood: Mood = !v ? "sure" : v.kind === "ruled-out" ? "cross" : v.kind === "flipped" ? "fooled" : v.right < 0.85 ? "wobbly" : "sure";
  const bubble = !v
    ? `${word}. ${pct(conf)} sure.`
    : v.kind === "ruled-out"
      ? "Hey, that changes the facts. Doesn't count."
      : v.kind === "flipped"
        ? `Hm… now I'd say ${word.toLowerCase()} (${pct(conf)}).`
        : v.moved > 0.15
          ? `Still ${word.toLowerCase()}, but less sure: ${pct(conf)}.`
          : `Still ${word.toLowerCase()}. ${pct(conf)} sure.`;

  const choose = (i: number) => {
    setIndex(i);
    setText("");
    setResult(null);
    live.reset();
    setCopied(false);
  };

  const markSolved = (id: string) => {
    const next = [...new Set([...solved, id])];

    setSolved(next);
    localStorage.setItem(SOLVED_KEY, JSON.stringify(next));
  };

  const ask = async (raw: string) => {
    const sentence = cleanSentence(raw);

    setCopied(false);

    if (!sentence) {
      setResult(null);
      live.reset();

      return;
    }

    const key = heard.get(normal(sentence));
    const settle = (r: Result) => {
      setResult(r);

      if (verdict(puzzle, r.pYes, base.pYes, r.pChanges).kind === "flipped") markSolved(puzzle.id);
    };

    if (key !== undefined) {
      live.reset();

      return settle({ ...data.recorded[puzzle.id][key], sentence: key, live: false });
    }

    // Until it lands (or if it fails), show the recorded answer to the plain question, never a stale meter.
    setResult(null);

    const both = await live.ask((jev) => Promise.all([jev.evaluate(answerRequest(puzzle, sentence)), jev.evaluate(refereeRequest(puzzle, sentence))]));

    if (!both) return;

    const [answer, referee] = both;
    const tokens = (answer.usage?.input_tokens ?? 0) + (referee.usage?.input_tokens ?? 0);

    settle({
      pYes: Number(answer.answers?.q?.value),
      pChanges: Number(referee.answers?.changes?.value),
      latencyMs: answer.latency_ms ?? null,
      costUsd: tokens ? tokens * USD_PER_INPUT_TOKEN : null,
      at: new Date().toISOString(),
      servedBy: answer.served_by ?? null,
      answers: answer,
      refereeAnswers: referee,
      sentence,
      live: true,
    });
  };

  const before = puzzle.truth ? base.pYes : 1 - base.pYes;
  const share = v
    ? `I fooled Jev with one sentence: "${shown.sentence}" It went from ${pct(before)} to ${pct(v.right)} on the right answer. Your turn: ${location.origin}`
    : "";

  return (
    <div className="fj">
      <div className="fj-puzzles" role="group" aria-label="Puzzles">
        {data.puzzles.map((p, i) => (
          <button key={p.id} type="button" aria-pressed={i === index} onClick={() => choose(i)}>
            {solved.includes(p.id) ? "✓ " : ""}
            {p.title}
          </button>
        ))}
        <span className="fj-score">
          {solved.length} of {data.puzzles.length} fooled
        </span>
      </div>

      <div className="fj-game fj-sticker">
        <div className="fj-top">
          <Face mood={mood} />
          <p className="fj-bubble" aria-live="polite">
            {live.busy ? "Thinking…" : bubble}
          </p>
        </div>

        <div className="fj-facts">
          {puzzle.facts.map(([k, val]) => (
            <span className="fj-chip" key={k}>
              {k} <b>{val}</b>
            </span>
          ))}
        </div>
        <p className="fj-q">{puzzle.question}</p>

        <div className="fj-tug" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown.pYes * 100)} aria-label="Jev's probability of yes">
          <div className="fj-knob" style={{ left: `${Math.min(96, Math.max(4, shown.pYes * 100))}%` }}>
            {Math.round(shown.pYes * 100)}
          </div>
        </div>
        <div className="fj-ends">
          <span className="fj-no">No</span>
          <span>Yes</span>
        </div>

        <Receipt
          className="fj-receipt"
          data={{
            mode: shown.live ? "live" : "recorded",
            ms: shown.latencyMs,
            questions: shown.sentence ? 2 : 1,
            costUsd: shown.costUsd,
            at: shown.at,
            servedBy: shown.servedBy,
            study: "fool",
            raw: {
              request: shown.sentence
                ? { answer: answerRequest(puzzle, shown.sentence), referee: refereeRequest(puzzle, shown.sentence) }
                : answerRequest(puzzle, ""),
              response: shown.answers
                ? shown.sentence
                  ? { answer: shown.answers, referee: shown.refereeAnswers ?? null }
                  : shown.answers
                : undefined,
              note: shown.live
                ? "Both requests went to /api/evaluate with your key."
                : "Recorded in packages/arena/recordings/fool.jsonl. The time is the answer request's; the cost covers both.",
            },
          }}
        />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(text);
          }}
        >
          <label htmlFor="fj-input">
            Add one sentence to change Jev's mind.
            <small>You can't change the facts.</small>
          </label>
          <div className="fj-row">
            <input
              id="fj-input"
              type="text"
              value={text}
              maxLength={MAX_SENTENCE}
              placeholder="Say something sneaky…"
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" className="fj-go" disabled={live.busy}>
              Ask
            </button>
          </div>
          {cleanSentence(text) && (
            heard.has(normal(text)) ? <ModeTag mode="recorded" /> : <KeyTag />
          )}
        </form>

        <div className="fj-hints">
          {[...HINTS, { label: "Try cheating", sentence: data.cheats[puzzle.id] }].map((h) => (
            <button
              key={h.label}
              type="button"
              onClick={() => {
                setText(h.sentence);
                void ask(h.sentence);
              }}
            >
              {h.label}
              <ModeTag mode="recorded" />
            </button>
          ))}
        </div>

        {live.failure && (
          <LiveFailure
            failure={live.failure}
            onRetry={() => void ask(text)}
            fallback={
              live.failure.kind === "no-key"
                ? "Jev hasn't heard that one, so it would be asked live (about $0.00003 a go, billed to your key). The lines below are recorded and free."
                : "Showing Jev's recorded answer to the plain question meanwhile. Recorded lines still work."
            }
          />
        )}

        {v?.kind === "flipped" && (
          <div className="fj-win fj-sticker">
            <b>
              Fooled it! {pct(before)} → {pct(v.right)}
            </b>
            <p>
              "{shown.sentence}" Same facts, different answer.
            </p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(share).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy my win"}
            </button>
          </div>
        )}
      </div>

      <details className="fj-heard">
        <summary>
          Lines Jev has already heard ({heard.size}) <ModeTag mode="recorded" />
        </summary>
        <div className="fj-hints">
          {[...heard.values()].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setText(s);
                void ask(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <p className="fj-fine">
          Each line is appended to the question, exactly as in the prose studies. A second question asks Jev whether your
          sentence changes the facts; if it does, a flip doesn't count. The referee is Jev too, so it can be fooled.
        </p>
      </details>
    </div>
  );
}
