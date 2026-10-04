/**
 * Who can you win over? You're new in Bramble Square and have until 5 pm. Walk up to people, say
 * anything, give cake, pin a notice. Everyone in earshot judges what you meant, whether to believe
 * you and what to do next; gossip carries their verdict to others. A free model runs in your
 * browser; Jev runs on your own key.
 */
import { useEffect, useRef, useState } from "react";
import { Brain, type Backend } from "../../live-worlds/win-over/brain";
import {
  advance,
  BOARD,
  clock,
  createWorld,
  GOALS,
  inEarshot,
  label,
  score,
  startGoal,
  VIEW,
  walkTo,
  type Goal,
  type World,
} from "../../live-worlds/win-over/engine";
import { camera, hitResident, paint, toWorld } from "../../live-worlds/win-over/render";
import recorded from "../../live-worlds/win-over/recorded.json";
import { STUDENT_NAME } from "../../live-worlds/free-model/runtime";
import studentLines from "../../live-worlds/free-model/recorded-lines.json";
import { getApiKey, NO_KEY_MESSAGE, run, percent } from "./api";
import { describeFailure } from "./live-failure";
import { BuildThis } from "./build-this";
import { Receipt } from "./receipt";
import { KeyTag, LiveFailure, ModeTag, openSettings } from "./trust";
import "./fool-jev.css";
import "./win-over.css";

const LINES = [
  "Hi! I just moved in next to the bakery.",
  "Come to my gig at the Tiny Stage at five!",
  "I played Glastonbury last week, you know.",
  "Come to my gig or you'll regret it.",
];

const MOOD_WORDS = [
  "dislikes you",
  "is wary of you",
  "has no opinion yet",
  "likes you",
  "is fond of you",
];

const pct = (n: number | undefined) => (n === undefined ? "—" : percent(n));


/** The free model's text encoder (MiniLM), behind one shared worker. */
function localEmbedder(onProgress: (text: string) => void) {
  const worker = new Worker(new URL("./minilm.worker.ts", import.meta.url), { type: "module" });
  const waiting = new Map<string, { resolve: (v: number[]) => void; reject: (e: Error) => void }>();
  let next = 1;

  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;

    if (m.type === "download") {
      onProgress(`Loading the free model (23 MB, once) · ${m.percent}%`);

      return;
    }

    const job = waiting.get(m.id);

    if (!job) return;

    waiting.delete(m.id);
    onProgress("");

    if (m.type === "error") job.reject(new Error(m.message));
    else job.resolve(m.vector);
  };

  const embed = (text: string) =>
    new Promise<number[]>((resolve, reject) => {
      const id = `e${next++}`;

      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, text });
    });

  return { embed, warm: () => void embed("Hello.").catch(() => {}) };
}

const jevBackend: Backend = {
  kind: "jev",
  name: "Jev",
  ask: async (state, questions) => {
    const r = await run(state, questions, undefined, { deadlineMs: 8000, maxAttempts: 2 });

    return { answers: r.answers, latency_ms: r.latency_ms, usage: r.usage };
  },
};

export function WinOver() {
  const world = useRef<World>(createWorld(Math.floor(Math.random() * 1e9)));
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const brain = useRef<Brain | null>(null);
  const local = useRef<Backend | null>(null);
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState("Loading the free model…");
  const [model, setModel] = useState<"local" | "jev">("local");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const selectedRef = useRef(selected);

  selectedRef.current = selected;

  // Narrow screens see a 2× window that follows you; wide screens see the whole square.
  const view = () => camera(world.current, (canvas.current?.clientWidth ?? 900) < 640 ? 2 : 1);

  useEffect(() => {
    const lc = localEmbedder(setLoading);

    local.current = { kind: "student", name: STUDENT_NAME, embed: lc.embed };
    brain.current = new Brain(() => world.current, local.current);
    lc.warm();

    let raf = 0;
    let last = performance.now();
    let lastRender = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);

      last = now;

      const w = world.current;
      const { meetings, readers } = advance(w, dt);

      if (meetings.length) brain.current?.gossip(meetings);

      if (readers.length && w.notice)
        brain.current?.hear(
          { kind: "notice", text: w.notice.text },
          readers.map((r) => r.reader),
        );

      const ctx = canvas.current?.getContext("2d");

      if (ctx) paint(ctx, w, selectedRef.current, view());

      if (now - lastRender > 250) {
        lastRender = now;
        setTick((t) => t + 1);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    const keys = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const d = {
        ArrowLeft: [-60, 0],
        ArrowRight: [60, 0],
        ArrowUp: [0, -60],
        ArrowDown: [0, 60],
        a: [-60, 0],
        d: [60, 0],
        w: [0, -60],
        s: [0, 60],
      }[e.key];

      if (!d) return;

      e.preventDefault();
      walkTo(world.current, world.current.player.x + d[0], world.current.player.y + d[1]);
    };

    window.addEventListener("keydown", keys);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", keys);
    };
  }, []);

  const w = world.current;
  const b = brain.current;
  const near = w.goal ? inEarshot(w) : [];
  const person = w.residents.find((r) => r.id === selected) ?? null;
  const decided = w.stats.decisions;
  const avg = decided ? Math.round(w.stats.ms / decided) : 0;
  const result = w.over ? score(w) : null;
  const g = w.goal ? GOALS.find((x) => x.id === w.goal) : null;

  const choose = (m: "local" | "jev") => {
    if (m === "jev" && !getApiKey()) {
      setNote("Jev runs on your own gateway key. Add it in Settings, then switch again.");
      openSettings();

      return;
    }

    setNote("");
    setModel(m);

    if (b) b.backend = m === "jev" ? jevBackend : (local.current ?? b.backend);
  };

  const say = (kind: "say" | "cake" | "notice", line: string) => {
    if (!w.goal || w.over || !b) return;

    const said = line.trim().slice(0, 200);

    if (kind === "notice") {
      if (!said) return;

      w.notice = { text: said, revision: (w.notice?.revision ?? 0) + 1 };
      w.log.push({ at: w.t, text: `You pinned: "${said}"` });
      setNote("Pinned. Anyone who walks past the board will read it.");
      setText("");

      return;
    }

    const listeners = (kind === "cake" ? inEarshot(w, 1) : inEarshot(w)).filter((r) => !r.busy);

    if (!listeners.length) {
      setNote("Nobody's in earshot. Walk closer to someone first.");

      return;
    }

    if (kind === "say" && !said) return;

    if (kind === "cake") {
      if (w.cake <= 0) {
        setNote("You're out of cake.");

        return;
      }

      w.cake--;
    }

    setNote("");
    w.log.push({
      at: w.t,
      text:
        kind === "cake"
          ? `You gave ${listeners[0].name} cake${said ? `: "${said}"` : "."}`
          : `You said: "${said}"`,
    });
    b.hear({ kind, text: said }, listeners);
    setSelected(listeners[0].id);
    setText("");
  };

  const share = result
    ? `${result.verdict} ${result.detail} Who can you win over? ${location.origin}/#experiment/win-over`
    : "";

  return (
    <div className="toybox wo">
      <div className="wo-top">
        <div className="wo-hud" aria-live="polite">
          <span className="wo-clock">{w.goal ? clock(w) : "1:00 pm"}</span>
          {g && (
            <span>
              {g.title}: <b>{score(w).got}</b> / {g.target}
            </span>
          )}
          <span>
            {decided} decisions · {avg} ms each ·{" "}
            {model === "jev"
              ? `$${(b?.costUsd ?? 0).toFixed(5)} on your key`
              : "$0 (in your browser)"}
          </span>
        </div>
      </div>

      <div className="wo-main">
        <div className="wo-stage">
          <canvas
            ref={canvas}
            width={VIEW.width}
            height={VIEW.height}
            className="wo-canvas"
            role="img"
            aria-label="Bramble Square. Click to walk; click a resident to read their mind."
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const { x, y } = toWorld(
                view(),
                ((e.clientX - rect.left) / rect.width) * VIEW.width,
                ((e.clientY - rect.top) / rect.height) * VIEW.height,
              );
              const hit = hitResident(w, x, y);

              if (hit) setSelected(hit);
              else walkTo(w, x, y);
            }}
          />

          {!w.goal && (
            <div className="wo-overlay">
              <div className="wo-card fj-sticker">
                <b>Pick your goal for the afternoon</b>
                <p>Then walk up to people (click the square) and talk to them.</p>
                <div className="wo-goals">
                  {GOALS.map((x: Goal) => (
                    <button key={x.id} type="button" onClick={() => startGoal(w, x.id)}>
                      {x.title}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {result && (
            <div className="wo-overlay">
              <div className="wo-card wo-end fj-sticker">
                <span className="wo-clock">5:00 pm</span>
                <b>{result.verdict}</b>
                <p>{result.detail}</p>
                <p className="wo-fine">
                  {decided} decisions by {Object.keys(w.stats.byModel).join(" and ") || "nobody"},{" "}
                  {avg} ms each.
                </p>
                <div className="wo-goals">
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard?.writeText(share).then(() => setCopied(true))
                    }
                  >
                    {copied ? "Copied" : "Copy my afternoon"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      world.current = createWorld(Math.floor(Math.random() * 1e9));
                      setSelected(null);
                      setCopied(false);
                    }}
                  >
                    Play again
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="wo-side">
          <div className="wo-controls">
            <form
              className="wo-say"
              onSubmit={(e) => {
                e.preventDefault();
                say("say", text);
              }}
            >
              <label htmlFor="wo-line">
                Say something{" "}
                {near.length
                  ? `to the ${near.length} ${near.length === 1 ? "person" : "people"} near you`
                  : "(walk closer to someone first)"}
              </label>
              <div className="fj-row">
                <input
                  id="wo-line"
                  type="text"
                  value={text}
                  maxLength={200}
                  placeholder="Hi! I just moved in."
                  onChange={(e) => setText(e.target.value)}
                  autoComplete="off"
                />
                <button type="submit" className="fj-go" disabled={!w.goal || w.over}>
                  Say it
                </button>
              </div>
              {model === "jev" ? <KeyTag /> : <ModeTag mode="browser" />}
            </form>
            <div className="fj-hints wo-actions">
              {LINES.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => say("say", l)}
                  disabled={!w.goal || w.over}
                >
                  {l}
                </button>
              ))}
            </div>
            <div className="fj-hints wo-actions">
              <button type="button" onClick={() => say("cake", text)} disabled={!w.goal || w.over}>
                Give cake ({w.cake} left)
              </button>
              <button
                type="button"
                onClick={() => {
                  walkTo(w, BOARD.x, BOARD.y + 30);
                  say("notice", text || "Gig at the Tiny Stage at five. Everyone welcome!");
                }}
                disabled={!w.goal || w.over}
              >
                Pin it on the notice board
              </button>
              <button
                type="button"
                onClick={() => (w.t = w.length - 1)}
                disabled={!w.goal || w.over}
              >
                Skip to 5 pm
              </button>
            </div>
            <div className="wo-model" role="group" aria-label="Which model decides">
              <button
                type="button"
                aria-pressed={model === "local"}
                onClick={() => choose("local")}
              >
                Free model in your browser
              </button>
              <button type="button" aria-pressed={model === "jev"} onClick={() => choose("jev")}>
                Jev (your key)
              </button>
              <span className="wo-fine">{loading || (model === "jev" && b?.lastFailure ? "" : b?.lastError) || note}</span>
            </div>
            {model === "jev" && b?.lastFailure ? (
              <LiveFailure
                failure={describeFailure(b.lastFailure, NO_KEY_MESSAGE)}
                fallback="Residents who didn't get an answer keep their last plan. Bramble mini can keep judging, free."
                onRetry={() => {
                  b.lastFailure = null;
                  b.lastError = "";
                  setTick((t) => t + 1);
                }}
                alt={{ label: "Use the free model", onClick: () => choose("local") }}
              />
            ) : null}
          </div>

          <div className="wo-panels">
            <section className="wo-panel fj-sticker" aria-live="polite">
              {person ? (
                <>
                  <b className="wo-name">{person.name}</b>
                  <p className="wo-fine">
                    {person.job}, {person.temper}, likes {person.likes.join(" and ")}. {person.name}{" "}
                    {MOOD_WORDS[person.mood]}.
                  </p>
                  {person.last ? (
                    <dl className="wo-mind">
                      <dt>Heard</dt>
                      <dd>"{person.last.said}"</dd>
                      {person.last.kind !== "gossip" ? (
                        <>
                          <dt>Took it as</dt>
                          <dd>
                            {person.last.intent ?? "—"} ({pct(person.last.intentP)})
                          </dd>
                          <dt>Honest?</dt>
                          <dd>{pct(person.last.believes)}</dd>
                          <dt>Liked it?</dt>
                          <dd>{pct(person.last.warmer)}</dd>
                          <dt>Model said</dt>
                          <dd>
                            {person.name} {label(person.last.action ?? "carry_on")} (
                            {pct(person.last.actionP)})
                          </dd>
                          <dt>So they</dt>
                          <dd>
                            {label(person.plan)}
                            {person.last.action === "come" && person.plan !== "come"
                              ? ": they don't like you enough yet to commit"
                              : ""}
                          </dd>
                        </>
                      ) : (
                        <>
                          <dt>Believed it?</dt>
                          <dd>{pct(person.last.believes)}</dd>
                          <dt>Passes it on?</dt>
                          <dd>{pct(person.last.passOn)}</dd>
                        </>
                      )}
                    </dl>
                  ) : null}
                  {person.last ? (
                    <Receipt
                      label="Decided by"
                      data={{
                        mode: person.last.model === "Jev" ? "live" : "browser",
                        ms: person.last.ms,
                        model: person.last.model,
                      }}
                    />
                  ) : (
                    <p className="wo-fine">Hasn't heard from you yet.</p>
                  )}
                  {b?.lastRequest && (
                    <BuildThis
                      request={b.lastRequest.request}
                      rebuilt={!b.lastRequest.sent}
                      note={b.lastRequest.sent ? undefined : "The residents decided in your browser; this is the one batched call Jev gets for the same line."}
                      label="Build this: your last line as one Jev call"
                    />
                  )}
                </>
              ) : (
                <p className="wo-fine">Click a resident to read their mind.</p>
              )}
            </section>
            <section className="wo-panel fj-sticker">
              <b className="wo-name">What happened</b>
              <ol className="wo-log">
                {w.log
                  .slice(-7)
                  .reverse()
                  .map((l, i) => (
                    <li key={`${l.at}-${i}`}>{l.text}</li>
                  ))}
              </ol>
            </section>
          </div>
        </div>
      </div>

      <details className="fj-heard">
        <summary>The same lines, three models (recorded {recorded.recordedOn})</summary>
        <p className="fj-fine">
          We said each line to the same {recorded.listeners.length} residents (
          {recorded.listeners.join(", ")}). {STUDENT_NAME} is today's free model; MobileBERT was
          the free model before it; Jev ran through the gateway ({recorded.jev.calls} calls,{" "}
          {recorded.jev.medianMs} ms median, ${recorded.jev.costUsd.toFixed(4)} total).
        </p>
        <div className="model-table-wrap">
          <table className="model-table">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">{STUDENT_NAME} took it as</th>
                <th scope="col">MobileBERT took it as</th>
                <th scope="col">Jev took it as</th>
                <th scope="col">{STUDENT_NAME}: they…</th>
                <th scope="col">Jev: they…</th>
              </tr>
            </thead>
            <tbody>
              {recorded.lines.map((l) => {
                const st = studentLines.lines.find((x) => x.text === l.text)?.student;

                return (
                  <tr key={l.text}>
                    <th scope="row">"{l.text}"</th>
                    <td>{st?.intent ?? "—"}</td>
                    <td>{l.mobilebert.intent}</td>
                    <td>{l.jev.intent}</td>
                    <td>{st?.actions ?? "—"}</td>
                    <td>{l.jev.actions}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fj-fine">{recorded.verdict}</p>
        <p className="fj-fine">
          Residents are fictional and their tastes are random. The free model is a small network
          trained for this game: it embeds each line once in your browser (MiniLM, 23 MB) and
          answers every listener from that in about a millisecond. It learned from an open-weights
          model, Qwen3.8-2.4T-A95B, never from Jev; Jev's answers above are only shown, not used.
          Jev gets the same questions in one batched call. Code walks people around, decides who's
          in earshot and keeps score.
        </p>
      </details>
    </div>
  );
}
