/**
 * One box, live: type into the box and every contestant that can run in the browser answers
 * as you go, under the same calm rules as the recorded replays. The keyword classifier runs
 * here, after upstream's 120 ms debounce. Jev runs through the gateway with your
 * key, but a key allows only a couple dozen answers a minute, far fewer than a keystroke each,
 * so live Jev asks when you pause (PAUSE_MS) with at most one request in flight. Laya runs only
 * on a Mac, so it has no live lane. Nothing typed here is stored.
 */
import { useEffect, useRef, useState } from "react";
import { answersSchema, toReading } from "../../../packages/arena/src/one-box/adapter";
import { calm, START, type Calm } from "../../../packages/arena/src/one-box/calm";
import { keyword } from "../../../packages/arena/src/one-box/keyword";
import { QUESTIONS, type Reading } from "../../../packages/arena/src/one-box/questions";
import { normalizeKey, TYPING } from "../../../packages/arena/src/one-box/replay";
import { EvaluationError, run, useHasKey } from "../api";
import { fromLive, Receipt, type ReceiptData } from "../receipt";
import { ModeTag } from "../trust";
import { colorVars, type CardModel } from "./model";
import { fromCalm, Shown } from "./one-box-ui";

type LaneId = "jev" | "keyword";

/** Which card contestant each live lane borrows its name and colour from. */
const CONTESTANT: Record<LaneId, string> = {
  jev: "jev@cancel",
  keyword: "code.keyword",
};

const NO_KEY_NOTE = "Connect your AI Gateway key in Settings to run Jev live.";

/** Live Jev waits for a pause this long before asking. */
const PAUSE_MS = 400;

type Lane = {
  calm: Calm;
  /** How long the last answer took, in ms. */
  lastMs: number | null;
  requests: number;
  note: string;
  /** The last live answer's receipt (Jev only). */
  receipt?: ReceiptData;
};

const fresh = (note = ""): Lane => ({ calm: START, lastMs: null, requests: 0, note });

/** Phrases to type out for you, written for this view (not from the scored set). */
const EXAMPLES = [
  "lunch with priya thursday at noon on zoom",
  "remind me to renew my passport before june",
  "split $84 for dinner between the 3 of us",
  "how many days until thanksgiving",
];

export function TryBox({ model: m }: { model: CardModel }) {
  const [text, setText] = useState("");
  // Re-renders when a key is connected, so the Jev lane and the tags follow it.
  const hasKey = useHasKey();

  const [lanes, setLanes] = useState<Record<LaneId, Lane>>({
    jev: fresh(hasKey ? "" : NO_KEY_NOTE),
    keyword: fresh(),
  });

  const timers = useRef(new Map<LaneId, ReturnType<typeof setTimeout>>());

  const jev = useRef<{ controller: AbortController | null; queued: string | null }>({
    controller: null,
    queued: null,
  });

  const typer = useRef<ReturnType<typeof setInterval> | null>(null);

  const apply = (id: LaneId, reading: Reading, forText: string, ms: number, note = "", receipt?: ReceiptData) =>
    setLanes((l) => ({
      ...l,
      [id]: {
        calm: calm(l[id].calm, reading, forText),
        lastMs: ms,
        requests: l[id].requests + 1,
        note,
        receipt: receipt ?? l[id].receipt,
      },
    }));

  const noteFor = (id: LaneId, note: string) =>
    setLanes((l) => ({ ...l, [id]: { ...l[id], note } }));

  /** Asks Jev about `ask`; under "latest", asks again for the newest text when it lands. */
  const askJev = (ask: string, started: number) => {
    const state = jev.current;

    if (state.controller) {
      state.queued = ask;

      return;
    }

    const controller = new AbortController();

    state.controller = controller;
    state.queued = null;

    run({ text: ask }, QUESTIONS, controller.signal, { deadlineMs: 4000, maxAttempts: 1 })
      .then((body: { answers?: unknown }) => {
        if (controller.signal.aborted) return;
        const { reading, dropped } = toReading(answersSchema.parse(body.answers));

        apply(
          "jev",
          reading,
          ask,
          Math.round(performance.now() - started),
          dropped.length ? `The gateway dropped ${dropped.join(" and ")}.` : "",
          fromLive(body, { state: { text: ask }, questions: QUESTIONS }),
        );
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        noteFor(
          "jev",
          error instanceof EvaluationError && error.status === 503
            ? "Jev is busy; keeping the last card."
            : error.message,
        );
      })
      .finally(() => {
        if (state.controller !== controller) return;
        state.controller = null;
        const next = state.queued;

        if (next !== null && normalizeKey(next) !== normalizeKey(ask))
          askJev(next, performance.now());
      });
  };

  // Every keystroke: blank text resets; otherwise each lane asks after upstream's debounce.
  const keystroke = (text: string) => {
    setText(text);
    const blank = normalizeKey(text).length < 2;

    for (const id of ["jev", "keyword"] as const) {
      clearTimeout(timers.current.get(id));

      if (blank) {
        if (id === "jev") {
          jev.current.controller?.abort();
          jev.current.controller = null;
          jev.current.queued = null;
        }

        setLanes((l) => ({ ...l, [id]: { ...l[id], calm: calm(l[id].calm, keyword(""), text) } }));
        continue;
      }

      timers.current.set(
        id,
        setTimeout(
          () => {
            if (id === "jev") {
              if (hasKey) askJev(text, performance.now());

              return;
            }

            const started = performance.now();

            apply(id, keyword(text), text, performance.now() - started);
          },
          id === "jev" ? PAUSE_MS : TYPING.debounceMs,
        ),
      );
    }
  };

  useEffect(
    () => () => {
      for (const t of timers.current.values()) clearTimeout(t);
      jev.current.controller?.abort();

      if (typer.current) clearInterval(typer.current);
    },
    [],
  );

  /** Types an example out at the recorded pace. */
  const typeOut = (phrase: string) => {
    if (typer.current) clearInterval(typer.current);
    const chars = Array.from(phrase);
    let i = 0;

    keystroke("");
    typer.current = setInterval(() => {
      i++;
      keystroke(chars.slice(0, i).join(""));

      if (i >= chars.length && typer.current) clearInterval(typer.current);
    }, TYPING.msPerKey);
  };

  return (
    <div className="ob-try">
      <p className="ob-try-rules muted small">
        The keyword rules answer {TYPING.debounceMs} ms after each keystroke, in
        your browser. Jev asks when you pause for {PAUSE_MS} ms, one request at a time: a key allows
        a couple dozen answers a minute, not one per keystroke. Nothing you type is stored.
      </p>

      <label className="ob-try-input">
        <span className="sr-only">Type something</span>
        <input
          type="text"
          value={text}
          placeholder="Type anything: a plan, a reminder, a bill to split…"
          onChange={(e) => {
            if (typer.current) clearInterval(typer.current);
            keystroke(e.target.value);
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <div className="ob-try-examples" role="group" aria-label="Examples">
        <span className="muted small">Or watch one typed:</span>
        {EXAMPLES.map((e) => (
          <button key={e} type="button" onClick={() => typeOut(e)}>
            {e}
            <ModeTag mode={hasKey ? "live" : "browser"} />
          </button>
        ))}
      </div>

      <div className="ob-lanes">
        {(["jev", "keyword"] as const).map((id) => {
          const cid = CONTESTANT[id];
          const c = m.contestant(cid);
          const lane = lanes[id];
          const label = id === "jev" ? "Jev · live" : m.label(cid);

          return (
            <article key={id} className="ob-lane" style={colorVars(c)} data-kind={c?.kind}>
              <header className="ob-lane-head">
                <span className="swatch" aria-hidden="true" />
                <span className="ob-lane-name" title={c?.name}>
                  {label}
                </span>
                {lane.lastMs !== null && (
                  <span className="ob-lane-ms muted small">
                    {lane.lastMs < 1 ? "<1" : Math.round(lane.lastMs)} ms
                  </span>
                )}
              </header>
              <div className="ob-box" aria-label={`${label}'s box`} aria-live="polite">
                <Shown state={fromCalm(lane.calm.shown)} />
              </div>
              <p className="ob-lane-note muted small">
                {(id === "jev" && hasKey && lane.note === NO_KEY_NOTE ? "" : lane.note) ||
                  (lane.requests ? `${lane.requests} answers` : "")}
              </p>
              {id === "jev" && lane.receipt && <Receipt data={lane.receipt} />}
            </article>
          );
        })}
      </div>
    </div>
  );
}
