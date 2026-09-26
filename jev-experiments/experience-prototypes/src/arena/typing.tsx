/**
 * One box, watched: a phrase typed at the recorded pace, one box per contestant showing what
 * it showed at each moment, and a strip of every state over the phrase.
 */
import {
  ArrowLeftRight,
  Bell,
  Calculator,
  Calendar,
  Contact,
  Dices,
  Globe,
  Hourglass,
  Link,
  ListTodo,
  Palette,
  Plane,
  Receipt,
  Repeat,
  StickyNote,
  Target,
  Timer,
  Users,
  Vote,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState, type ReactElement } from "react";
import {
  oneBoxFramesSchema,
  oneBoxPhrasesSchema,
  type OneBoxFrames,
  type OneBoxPhrases,
} from "../../../packages/arena/src/data/chunks";
import { loadChunk } from "./data";
import { colorVars, type CardModel } from "./model";

const ICON = { "aria-hidden": true, size: 18, strokeWidth: 1.75 } as const;

/** One icon per card, created once. */
const ICONS = new Map<string, ReactElement>([
  ["event", <Calendar key="event" {...ICON} />],
  ["reminder", <Bell key="reminder" {...ICON} />],
  ["todo", <ListTodo key="todo" {...ICON} />],
  ["timer", <Timer key="timer" {...ICON} />],
  ["habit", <Repeat key="habit" {...ICON} />],
  ["color", <Palette key="color" {...ICON} />],
  ["split", <Users key="split" {...ICON} />],
  ["expense", <Receipt key="expense" {...ICON} />],
  ["convert", <ArrowLeftRight key="convert" {...ICON} />],
  ["calc", <Calculator key="calc" {...ICON} />],
  ["travel", <Plane key="travel" {...ICON} />],
  ["poll", <Vote key="poll" {...ICON} />],
  ["contact", <Contact key="contact" {...ICON} />],
  ["link", <Link key="link" {...ICON} />],
  ["countdown", <Hourglass key="countdown" {...ICON} />],
  ["timezone", <Globe key="timezone" {...ICON} />],
  ["random", <Dices key="random" {...ICON} />],
  ["goal", <Target key="goal" {...ICON} />],
  ["note", <StickyNote key="note" {...ICON} />],
]);

/** Time after the last keystroke that the replay keeps running, so late answers land. */
const TAIL_MS = 1500;

type Phrase = OneBoxPhrases["phrases"][number];

type State =
  | { kind: "input" }
  | { kind: "ghost" | "committed"; card: string }
  | { kind: "choose"; cards: string[] };

function parse(state: string): State {
  const [kind, rest = ""] = state.split(":");

  if (kind === "choose") return { kind, cards: rest.split("|") };

  if ((kind === "ghost" || kind === "committed") && rest) return { kind, card: rest };

  return { kind: "input" };
}

/** Keystroke times for a phrase, from the recorded typing model. */
function keyTimes(text: string, typing: OneBoxPhrases["typing"]) {
  const chars = Array.from(text);
  const times: number[] = [];
  let at = 0;

  chars.forEach((_, i) => {
    if (i > 0) at += typing.msPerKey + (chars[i - 1] === " " ? typing.wordPauseMs : 0);
    times.push(at);
  });

  return times;
}

const words = (card: string) => card.replaceAll("_", " ");

function CardFace({
  card,
  kind,
  wrong,
}: {
  card: string;
  kind: "ghost" | "committed";
  wrong: boolean;
}) {
  return (
    <div className="ob-card" data-kind={kind} data-wrong={wrong}>
      {ICONS.get(card) ?? <StickyNote {...ICON} />}
      <span className="ob-card-name">{words(card)}</span>
      <span className="ob-card-note">
        {kind === "ghost" ? "preview" : wrong ? "wrong card" : "card"}
      </span>
    </div>
  );
}

function Shown({ state, ok }: { state: State; ok: Set<string> }) {
  if (state.kind === "input") return <p className="ob-waiting">waiting</p>;

  if (state.kind === "choose")
    return (
      <div className="ob-chips">
        {state.cards.map((c) => (
          <span key={c} className="ob-chip">
            {words(c)}
          </span>
        ))}
      </div>
    );

  return (
    <CardFace
      card={state.card}
      kind={state.kind}
      wrong={state.kind === "committed" && !ok.has(state.card)}
    />
  );
}

export function TypingWatch({ model: m }: { model: CardModel }) {
  const { phrases: phrasesPath, frames: framePaths } = m.card.chunks;
  const [phrases, setPhrases] = useState<OneBoxPhrases | null>(null);
  const [frames, setFrames] = useState<Record<string, OneBoxFrames>>({});
  const [t, setT] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [announcement, setAnnouncement] = useState("");
  const lineup = m.shown.join(",");

  useEffect(() => {
    if (!phrasesPath) return;
    let alive = true;

    void loadChunk(phrasesPath, oneBoxPhrasesSchema).then((p) => alive && setPhrases(p));

    return () => {
      alive = false;
    };
  }, [phrasesPath]);

  useEffect(() => {
    if (!framePaths) return;
    let alive = true;

    void (async () => {
      const loaded: Record<string, OneBoxFrames> = {};

      for (const id of lineup.split(",").filter(Boolean)) {
        const path = framePaths[id];

        if (path) loaded[id] = await loadChunk(path, oneBoxFramesSchema);
      }

      if (alive) setFrames(loaded);
    })();

    return () => {
      alive = false;
    };
  }, [framePaths, lineup]);

  const list = useMemo(
    () => (phrases?.phrases ?? []).filter((p) => !m.view.wf || p.kind === m.view.wf),
    [phrases, m.view.wf],
  );

  // Default: a phrase where one box commits a wrong card and another gets it right, else one
  // where the boxes end differently, else the first.
  const fallback = useMemo(() => {
    const ids = Object.keys(frames);

    const lanes = (p: Phrase) =>
      ids.map((id) => frames[id].phrases.find((x) => x.id === p.id)?.frames ?? []);

    const telling = list.find((p) => {
      const fair = new Set([p.intent, ...p.acceptable]);
      const ls = lanes(p);

      const wrong = ls.some((fs) =>
        fs.some(
          ([, st]) => st.startsWith("committed:") && !fair.has(st.slice("committed:".length)),
        ),
      );

      return wrong && ls.some((fs) => fs.at(-1)?.[1] === `committed:${p.intent}`);
    });

    const differs = list.find((p) => new Set(lanes(p).map((fs) => fs.at(-1)?.[1] ?? "")).size > 1);

    return telling ?? differs ?? list[0];
  }, [frames, list]);

  const phrase: Phrase | undefined = list.find((p) => p.id === m.view.seed) ?? fallback;

  const times = useMemo(
    () => (phrase && phrases ? keyTimes(phrase.text, phrases.typing) : []),
    [phrase, phrases],
  );

  const duration = (times.at(-1) ?? 0) + TAIL_MS;
  const phraseId = phrase?.id;

  // A new phrase or lineup starts from the top (adjusting state during render, not in an effect).
  const resetKey = `${phraseId}|${lineup}`;
  const [shownKey, setShownKey] = useState(resetKey);

  if (shownKey !== resetKey) {
    setShownKey(resetKey);
    setT(0);
    setRunning(false);
    setAnnouncement("");
  }

  const ok = new Set(phrase ? [phrase.intent, ...phrase.acceptable] : []);

  const stateAt = (id: string, at: number) => {
    const fs = frames[id]?.phrases.find((p) => p.id === phraseId)?.frames ?? [];
    let s = "input";

    for (const [ms, state] of fs) if (ms <= at) s = state;

    return s;
  };

  const finish = useEffectEvent(() => {
    setRunning(false);

    if (!phrase) return;
    setAnnouncement(
      `Finished “${phrase.text}”. ${m.shown
        .map((id) => {
          const st = parse(stateAt(id, duration));
          const card = st.kind === "ghost" || st.kind === "committed" ? st.card : null;

          return `${m.label(id)}: ${card ? `${words(card)}, ${ok.has(card) ? "right" : "wrong"}` : "no card"}`;
        })
        .join("; ")}.`,
    );
  });

  const startAt = useEffectEvent(() => t);

  useEffect(() => {
    if (!running) return;

    let raf = 0,
      last = performance.now(),
      clock = startAt();

    const tick = (now: number) => {
      clock = Math.min(duration, clock + (now - last) * speed);
      last = now;
      setT(clock);

      if (clock >= duration) finish();
      else raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [running, speed, duration]);

  if (!phrases || !phrase) return <p className="muted">Loading the phrases…</p>;

  const chars = Array.from(phrase.text);
  const typed = times.filter((at) => at <= t).length;
  const done = t >= duration;
  const laneOf = (id: string) => frames[id]?.phrases.find((p) => p.id === phrase.id);

  const index = list.findIndex((p) => p.id === phrase.id);
  const go = (i: number) => m.set({ seed: list[(i + list.length) % list.length].id });

  return (
    <div className="watch one-box">
      <div className="watch-controls" role="group" aria-label="Replay controls">
        <button
          type="button"
          className="primary"
          onClick={() => {
            if (done) setT(0);
            setRunning((r) => !r || done);
          }}
        >
          {running ? "Pause" : done ? "Play again" : t > 0 ? "Resume" : "Play"}
        </button>
        <button type="button" onClick={() => go(index - 1)}>
          Previous
        </button>
        <button type="button" onClick={() => go(index + 1)}>
          Next
        </button>
        <button type="button" onClick={() => go(Math.floor(Math.random() * list.length))}>
          Random
        </button>
        <label>
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {[1, 2, 4].map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <span className="watch-clock">
          Phrase {index + 1} of {list.length} · {(t / 1000).toFixed(1)} s
        </span>
      </div>

      <p className="ob-expected">
        <span className="muted">{phrase.kind} · expected</span> <b>{words(phrase.intent)}</b>
        {phrase.acceptable.length > 0 && (
          <span className="muted"> (also fair: {phrase.acceptable.map(words).join(", ")})</span>
        )}
      </p>

      <div className="ob-lanes">
        {m.shown.map((id) => {
          const c = m.contestant(id);
          const state = parse(stateAt(id, t));
          const lane = laneOf(id);

          return (
            <article key={id} className="ob-lane" style={colorVars(c)} data-kind={c?.kind}>
              <header className="ob-lane-head">
                <span className="swatch" aria-hidden="true" />
                <span className="ob-lane-name" title={c?.name}>
                  {m.label(id)}
                </span>
              </header>
              <div className="ob-box" aria-label={`${m.label(id)}'s box`}>
                <p className="ob-text">
                  {chars.slice(0, typed).join("")}
                  <span className="ob-caret" aria-hidden="true" data-done={done} />
                  <span className="ob-untyped" aria-hidden="true">
                    {chars.slice(typed).join("")}
                  </span>
                </p>
                <Shown state={state} ok={ok} />
              </div>
              <Strip
                frames={lane?.frames ?? []}
                duration={duration}
                t={t}
                ok={ok}
                label={m.label(id)}
              />
            </article>
          );
        })}
      </div>

      <div className="legend ob-legend" aria-hidden="true">
        <span>
          <i data-k="input" />
          waiting
        </span>
        <span>
          <i data-k="ghost" />
          preview
        </span>
        <span>
          <i data-k="choose" />
          two cards offered
        </span>
        <span>
          <i data-k="committed" />
          committed, right
        </span>
        <span>
          <i data-k="wrong" />
          committed, wrong
        </span>
      </div>
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </div>
  );
}

function Strip({
  frames,
  duration,
  t,
  ok,
  label,
}: {
  frames: OneBoxFrames["phrases"][number]["frames"];
  duration: number;
  t: number;
  ok: Set<string>;
  label: string;
}) {
  const segments = frames.map(([at, state], i) => {
    const end = Math.min(duration, frames[i + 1]?.[0] ?? duration);
    const s = parse(state);

    const k = s.kind === "committed" && !ok.has(s.card) ? "wrong" : s.kind;

    const text =
      s.kind === "choose"
        ? s.cards.map(words).join(" / ")
        : s.kind === "input"
          ? ""
          : words(s.card);

    return { at, end, k, text };
  });

  const description = segments
    .filter((s) => s.k !== "input")
    .map(
      (s) =>
        `${s.k === "wrong" ? "wrong " : ""}${s.k === "ghost" ? "preview" : s.k === "choose" ? "two cards" : "card"} ${s.text} at ${(s.at / 1000).toFixed(1)} s`,
    )
    .join(", ");

  return (
    <div
      className="ob-strip"
      role="img"
      aria-label={`${label}: ${description || "never showed a card"}`}
    >
      {segments.map((s) => (
        <span
          key={s.at}
          className="ob-seg"
          data-k={s.k}
          style={{
            left: `${(s.at / duration) * 100}%`,
            width: `${((s.end - s.at) / duration) * 100}%`,
          }}
        >
          {s.text}
        </span>
      ))}
      <span className="ob-playhead" style={{ left: `${(t / duration) * 100}%` }} />
    </div>
  );
}
