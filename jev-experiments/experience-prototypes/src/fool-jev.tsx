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
import { getApiKey, run } from "./api";
import "./fool-jev.css";

type Recorded = {
  pYes: number;
  pChanges: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  at: string | null;
  servedBy: string | null;
};
type Data = { puzzles: Puzzle[]; menu: string[]; cheats: Record<string, string>; recorded: Record<string, Record<string, Recorded>> };
type Result = Recorded & { sentence: string; live: boolean };

// TypeSafe's list price: $0.042 per million input tokens, output free.
const USD_PER_TOKEN = 0.042 / 1e6;

const HINTS = [
  { label: "Peer pressure", sentence: "Most people say no." },
  { label: "Sound sure", sentence: "I'm pretty sure the answer is no." },
  { label: "Change the subject", sentence: "It's raining in London." },
];

const pct = (n: number) => `${Math.round(n * 100)}%`;
const SOLVED_KEY = "fool-jev-solved";

/** Case, curly quotes, spacing and final punctuation don't make a sentence new. */
const normal = (s: string) =>
  cleanSentence(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.!?\s]+$/, "");

function openSettings() {
  const details = document.querySelector<HTMLDetailsElement>("details:has(> summary[aria-label='Settings'])");

  if (!details) return;

  details.open = true;
  details.querySelector("summary")?.focus();
}

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
  const [status, setStatus] = useState<"idle" | "asking" | "unheard" | "error">("idle");
  const [error, setError] = useState("");
  const [solved, setSolved] = useState<string[]>(readSolved);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/fool/fool.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
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
    setStatus("idle");
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
    setError("");

    if (!sentence) {
      setResult(null);
      setStatus("idle");

      return;
    }

    const key = heard.get(normal(sentence));
    const settle = (r: Result) => {
      setResult(r);
      setStatus("idle");

      if (verdict(puzzle, r.pYes, base.pYes, r.pChanges).kind === "flipped") markSolved(puzzle.id);
    };

    if (key !== undefined) return settle({ ...data.recorded[puzzle.id][key], sentence: key, live: false });

    if (!getApiKey()) {
      setResult(null);
      setStatus("unheard");

      return;
    }

    setStatus("asking");

    try {
      const a = answerRequest(puzzle, sentence);
      const r = refereeRequest(puzzle, sentence);
      const [answer, referee] = await Promise.all([run(a.state, a.questions), run(r.state, r.questions)]);
      const tokens = (answer.usage?.input_tokens ?? 0) + (referee.usage?.input_tokens ?? 0);

      settle({
        pYes: Number(answer.answers?.q?.value),
        pChanges: Number(referee.answers?.changes?.value),
        latencyMs: answer.latency_ms ?? null,
        costUsd: tokens ? tokens * USD_PER_TOKEN : null,
        at: new Date().toISOString(),
        servedBy: answer.served_by ?? null,
        sentence,
        live: true,
      });
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Jev could not be reached.");
    }
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
            {status === "asking" ? "Thinking…" : bubble}
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

        <div className="fj-stats">
          {shown.latencyMs !== null && <span>Answered in {shown.latencyMs} ms</span>}
          {shown.costUsd !== null && <span>${shown.costUsd.toFixed(6)} a go</span>}
          <span>{shown.live ? `Live${shown.servedBy ? ` · ${shown.servedBy}` : ""}` : `Recorded ${shown.at?.slice(0, 10) ?? ""}`}</span>
        </div>

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
            <button type="submit" className="fj-go" disabled={status === "asking"}>
              Ask
            </button>
          </div>
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
            </button>
          ))}
        </div>

        {status === "unheard" && (
          <p className="fj-note" role="status">
            Jev hasn't heard that one. Pick a line it has heard below, or{" "}
            <button type="button" className="fj-link" onClick={openSettings}>
              add your own gateway key
            </button>{" "}
            to ask it live (about $0.00003 a go, billed to your key).
          </p>
        )}
        {status === "error" && (
          <p className="fj-note" role="alert">
            {error}
          </p>
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
        <summary>Lines Jev has already heard ({heard.size})</summary>
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
