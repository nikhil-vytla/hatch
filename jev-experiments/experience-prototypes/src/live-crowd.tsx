import { useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  GitBranch,
  CloudRain,
  Sun,
  Volume2,
  ArrowRight,
  Users,
  MousePointer2,
  Sparkles,
  Clock,
  Download,
  ChevronDown,
} from "lucide-react";
import { getApiKey, run, download, EvaluationError } from "./api";
import {
  STEP,
  PLACES,
  PERSONAS,
  createPair,
  copy,
  advance,
  checkpoint,
  forkPair,
  compareJev,
  setController,
  setNotice,
  humanTarget,
  releaseHuman,
  issueTicket,
  applyReply,
  observation,
  questions,
  addEvent,
  welfare,
  isOpen,
  place,
  type Pair,
  type Checkpoint,
  type Controller,
  type World,
  type PlaceId,
} from "../../live-worlds/crowd/engine";
import demo from "../../live-worlds/crowd/demo.json";
import {
  replayPlan,
  FixedClock,
  beginRequest,
  finishRequest,
} from "../../live-worlds/crowd/engine";
import { paint, hitResident, VIEW } from "../../live-worlds/crowd/render";
import "./live-crowd.css";
type Lane = "a" | "b";
type SavedRun = { id: string; label: string; frames: Checkpoint[] };
const time = (t: number) =>
  `${Math.floor(t / 60)}:${Math.floor(t % 60)
    .toString()
    .padStart(2, "0")}`;
const titles: Record<Controller, string> = {
  needs: "Needs only",
  notice: "Local notice rules",
  jev: "Jev destinations",
  human: "You decide",
};
const sourceNames = {
  needs: "Local needs policy",
  notice: "Local notice rules",
  jev: "Jev destination",
  human: "Your intervention",
};
const NOTICES = [
  {
    label: "A quiet invitation",
    text: "A quiet tea-and-book afternoon in the reading room. Come if you need a break from conversation.",
  },
  {
    label: "Find your people",
    text: "New to the neighborhood? Musicians and curious listeners are meeting at the tiny stage. No performance experience needed.",
  },
  {
    label: "Seeds, not sweets",
    text: "Seed swapping in the kitchen garden. Bring your plant questions. This is not a cake sale.",
  },
  {
    label: "A change of plan",
    text: "The music gathering is cancelled. Anyone who wanted to sing can meet for tea at the café instead.",
  },
];
export function LiveCrowd(_props: { result?: unknown }) {
  const pairRef = useRef<Pair | null>(null);
  if (!pairRef.current) pairRef.current = createPair();
  const frames = useRef<Checkpoint[]>([]),
    archives = useRef<SavedRun[]>([]),
    serial = useRef(1);
  if (!frames.current.length)
    frames.current = [
      {
        ...checkpoint(pairRef.current),
        ui: {
          speed: 1,
          selection: "r0",
          activeLane: "b",
          draft: NOTICES[0].text,
          postTo: "b",
        },
      },
    ];
  const [version, setVersion] = useState(0),
    [playing, setPlaying] = useState(true),
    [speed, setSpeed] = useState(1),
    [selected, setSelected] = useState("r0"),
    [activeLane, setActiveLane] = useState<Lane>("b"),
    [frame, setFrame] = useState<number | null>(null),
    [archive, setArchive] = useState<string | null>(null),
    [draft, setDraft] = useState(NOTICES[0].text),
    [postTo, setPostTo] = useState<"both" | Lane>("b"),
    [error, setError] = useState(""),
    [pending, setPending] = useState<Record<Lane, boolean>>({
      a: false,
      b: false,
    }),
    [inspector, setInspector] = useState(false);
  const editor = useRef({ draft, postTo });
  editor.current = { draft, postTo };
  const running = useRef(true),
    rate = useRef(1),
    selection = useRef(selected),
    active = useRef<Lane>("b"),
    view = useRef({
      frame: null as number | null,
      archive: null as string | null,
    }),
    busy = useRef<Record<Lane, boolean>>({ a: false, b: false }),
    controllers = useRef<Partial<Record<Lane, AbortController>>>({});
  const requestIds = useRef<Partial<Record<Lane, string>>>({});
  const simClock = useRef(new FixedClock()),
    previousFrame = useRef<number | null>(null);
  const canvases = useRef<Partial<Record<Lane, HTMLCanvasElement | null>>>({}),
    reduced = useRef(false),
    mounted = useRef(true),
    lastSavedTick = useRef(0),
    lastPublish = useRef(0);
  const bump = () => setVersion((v) => v + 1);
  function viewFrames() {
    return view.current.archive
      ? (archives.current.find((a) => a.id === view.current.archive)?.frames ??
          frames.current)
      : frames.current;
  }
  function displayed() {
    return view.current.frame === null
      ? pairRef.current!
      : (viewFrames()[view.current.frame]?.pair ?? pairRef.current!);
  }
  function snap(label: string) {
    const c = checkpoint(pairRef.current!, label);
    c.ui = {
      speed: rate.current,
      selection: selection.current,
      activeLane: active.current,
      ...editor.current,
    };
    return c;
  }
  function capture(label: string) {
    frames.current.push(snap(label));
    lastSavedTick.current = pairRef.current!.a.tick;
  }
  function cancelLane(lane: Lane, reason: string) {
    const w = pairRef.current![lane],
      id = requestIds.current[lane];
    if (id) {
      finishRequest(w, id, "cancelled", { error: reason });
      delete requestIds.current[lane];
      addEvent(w, "cancelled", reason);
    }
    controllers.current[lane]?.abort();
    delete controllers.current[lane];
    busy.current[lane] = false;
  }
  function invalidate(reason: string) {
    for (const lane of ["a", "b"] as const) {
      cancelLane(lane, reason);
      pairRef.current![lane].epoch++;
    }
    setPending({ a: false, b: false });
  }
  function safeError(e: unknown) {
    let text =
      e instanceof Error ? e.message : "Jev did not return a valid decision.";
    const key = getApiKey();
    if (key) text = text.split(key).join("[redacted]");
    return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
  }
  function pause() {
    simClock.current.reset();
    previousFrame.current = null;
    running.current = false;
    setPlaying(false);
    invalidate("Request cancelled when the world was paused.");
    bump();
  }
  function returnLive() {
    view.current = { frame: null, archive: null };
    setFrame(null);
    setArchive(null);
    bump();
  }
  function storeCurrent() {
    capture("Preserved run");
    archives.current.push({
      id: pairRef.current!.id,
      label: pairRef.current!.label,
      frames: frames.current,
    });
  }
  function fork(useJev = false) {
    pause();
    const all = viewFrames(),
      from =
        view.current.frame === null
          ? snap("Current state")
          : copy(all[view.current.frame]);
    storeCurrent();
    const id = `afternoon-${++serial.current}`;
    pairRef.current = useJev
      ? compareJev(from, id)
      : forkPair(from, id, `Branch ${serial.current} · ${time(from.at)}`);
    frames.current = [
      {
        ...checkpoint(pairRef.current!, "Branch starts here"),
        ui: from.ui
          ? copy(from.ui)
          : {
              speed: rate.current,
              selection: selection.current,
              activeLane: active.current,
              ...editor.current,
            },
      },
    ];
    lastSavedTick.current = pairRef.current!.a.tick;
    view.current = { frame: null, archive: null };
    setFrame(null);
    setArchive(null);
    if (from.ui) {
      rate.current = from.ui.speed;
      setSpeed(from.ui.speed);
      selection.current = from.ui.selection;
      setSelected(from.ui.selection);
      active.current = from.ui.activeLane;
      setActiveLane(from.ui.activeLane);
      if (from.ui.draft !== undefined) setDraft(from.ui.draft);
      if (from.ui.postTo) setPostTo(from.ui.postTo);
    }
    running.current = true;
    setPlaying(true);
    setError("");
    bump();
  }
  function toggle() {
    if (view.current.frame !== null) {
      fork();
      return;
    }
    if (running.current) pause();
    else {
      running.current = true;
      setPlaying(true);
    }
  }
  function selectResident(id: string, lane: Lane) {
    selection.current = id;
    active.current = lane;
    setSelected(id);
    setActiveLane(lane);
    setInspector(true);
  }
  async function ask(lane: Lane) {
    if (view.current.frame !== null) {
      setError(
        "Return to the live afternoon or branch from this checkpoint first.",
      );
      return;
    }
    const w = pairRef.current![lane];
    if (w.controller !== "jev") {
      setError("Choose Jev destinations for this side first.");
      return;
    }
    if (!getApiKey()) {
      setError(
        "Connect your Jev key in the page’s live controls first. Local policies keep working.",
      );
      return;
    }
    if (busy.current[lane]) return;
    const ticket = issueTicket(w);
    if (!Object.keys(ticket.actors).length) {
      setError(
        "Everyone is visiting or under your control. Ask again when residents are ready for a new plan.",
      );
      return;
    }
    const abort = new AbortController();
    controllers.current[lane] = abort;
    busy.current[lane] = true;
    setPending({ ...busy.current });
    setError("");
    addEvent(
      w,
      "requested",
      `Reading the notice for ${Object.keys(ticket.actors).length} residents.`,
    );
    const input = observation(w, ticket),
      q = questions(ticket),
      receiptId = beginRequest(w, ticket, input, q);
    requestIds.current[lane] = receiptId;
    capture("Jev request issued");
    try {
      const reply = await run(input, q, abort.signal);
      if (abort.signal.aborted || !mounted.current) return;
      const current = pairRef.current![lane];
      current.modelMode = "live";
      const result = applyReply(current, ticket, reply.answers);
      finishRequest(current, receiptId, "returned", {
        response: reply,
        outcome: result,
      });
      const ev = current.decisions.at(-1);
      if (ev)
        ev.transport = {
          latency_ms: reply.latency_ms,
          service_latency_ms: reply.service_latency_ms,
          retries: reply.retries,
          model: reply.model,
          source: "live",
          input,
          questions: q,
        };
      addEvent(
        current,
        "response",
        `${result.accepted} accepted · ${result.stale} expired · ${result.illegal} rejected.`,
      );
      capture("Jev response received");
    } catch (e) {
      if (abort.signal.aborted || !mounted.current) return;
      const current = pairRef.current![lane];
      if (current.id === ticket.branch && current.epoch === ticket.epoch) {
        current.metrics.failed++;
        const message = safeError(e);
        finishRequest(current, receiptId, "failed", {
          error: message,
          response:
            e instanceof EvaluationError
              ? { status: e.status, body: e.response }
              : undefined,
        });
        addEvent(current, "failed", message);
        setError(message);
        capture("Jev request failed");
      }
    } finally {
      if (controllers.current[lane] === abort) {
        delete controllers.current[lane];
        delete requestIds.current[lane];
        busy.current[lane] = false;
        if (mounted.current) {
          setPending({ ...busy.current });
          bump();
        }
      }
    }
  }
  function post() {
    if (view.current.frame !== null) return;
    const lanes: Lane[] = postTo === "both" ? ["a", "b"] : [postTo];
    for (const lane of lanes) {
      cancelLane(lane, "A newer announcement replaced this request.");
      setNotice(pairRef.current![lane], draft);
    }
    setPending({ ...busy.current });
    capture("New notice");
    bump();
    for (const lane of lanes)
      if (pairRef.current![lane].controller === "jev") void ask(lane);
  }
  function configure(
    lane: Lane,
    controller: Controller,
    assisted = pairRef.current![lane].assisted,
  ) {
    cancelLane(lane, "Controller settings changed.");
    setPending({ ...busy.current });
    setController(pairRef.current![lane], controller, assisted);
    capture("Controller changed");
    bump();
  }
  function scrub(index: number) {
    pause();
    view.current.frame = index;
    setFrame(index);
    bump();
  }
  function openArchive(id: string) {
    pause();
    const a = archives.current.find((a) => a.id === id);
    if (!a) return;
    view.current = { archive: id, frame: a.frames.length - 1 };
    setArchive(id);
    setFrame(a.frames.length - 1);
    bump();
  }
  function playRecorded() {
    pause();
    storeCurrent();
    pairRef.current = replayPlan(
      demo.result.snapshot as unknown as World,
      demo.result.ticket,
      demo.result.response.answers,
      `afternoon-${++serial.current}`,
    );
    for (const lane of ["a", "b"] as const) {
      const ev = pairRef.current[lane].decisions.at(-1);
      if (ev)
        ev.transport = {
          source: "recorded",
          request_sha256: demo.manifest.request_sha256,
          request: demo.result.request,
          response: demo.result.response,
          playback: demo.result.playback,
        };
    }
    frames.current = [
      {
        ...checkpoint(pairRef.current, "Recorded plan begins"),
        ui: {
          speed: rate.current,
          selection: selection.current,
          activeLane: active.current,
          draft: pairRef.current.a.notice,
          postTo: "both",
        },
      },
    ];
    lastSavedTick.current = pairRef.current.a.tick;
    setDraft(pairRef.current.a.notice);
    setPostTo("both");
    returnLive();
    running.current = true;
    setPlaying(true);
    setError("");
    bump();
  }
  function restart() {
    pause();
    storeCurrent();
    pairRef.current = createPair(27, `afternoon-${++serial.current}`);
    pairRef.current.label = `Fresh afternoon ${serial.current}`;
    frames.current = [snap("Fresh afternoon")];
    lastSavedTick.current = 0;
    returnLive();
    running.current = true;
    setPlaying(true);
    bump();
  }
  useEffect(() => {
    mounted.current = true;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = mq.matches;
    const changed = () => {
      reduced.current = mq.matches;
    };
    mq.addEventListener("change", changed);
    let raf = 0;
    previousFrame.current = null;
    simClock.current.reset();
    const visibility = () => {
      previousFrame.current = null;
      simClock.current.reset();
    };
    document.addEventListener("visibilitychange", visibility);
    function loop(now: number) {
      const delta =
        previousFrame.current === null
          ? 0
          : Math.max(0, (now - previousFrame.current) / 1000);
      previousFrame.current = now;
      if (running.current && view.current.frame === null && !document.hidden) {
        const count = simClock.current.take(delta, rate.current);
        for (let step = 0; step < count; step++) {
          advance(pairRef.current!.a);
          advance(pairRef.current!.b);
          if (pairRef.current!.a.tick - lastSavedTick.current >= 60) {
            frames.current.push(snap("Every two seconds"));
            lastSavedTick.current = pairRef.current!.a.tick;
          }
        }
      } else simClock.current.reset();
      const p = displayed(),
        dark = document.documentElement.dataset.theme === "dark";
      for (const lane of ["a", "b"] as const) {
        const canvas = canvases.current[lane];
        if (!canvas) continue;
        const dpr = Math.min(devicePixelRatio || 1, 2),
          width = canvas.clientWidth,
          height = (width * VIEW.height) / VIEW.width;
        if (
          canvas.width !== Math.round(width * dpr) ||
          canvas.height !== Math.round(height * dpr)
        ) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(
            canvas.width / VIEW.width,
            0,
            0,
            canvas.height / VIEW.height,
            0,
            0,
          );
          paint(ctx, p[lane], selection.current, reduced.current, dark);
        }
      }
      if (now - lastPublish.current > 180) {
        lastPublish.current = now;
        if (mounted.current) bump();
      }
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
    return () => {
      mounted.current = false;
      cancelAnimationFrame(raf);
      mq.removeEventListener("change", changed);
      document.removeEventListener("visibilitychange", visibility);
      simClock.current.reset();
      previousFrame.current = null;
      for (const lane of ["a", "b"] as const)
        cancelLane(lane, "Courtyard closed.");
    };
  }, []);
  void version;
  const pair = displayed(),
    live = frame === null,
    history = viewFrames(),
    person = pair[activeLane].residents.find((r) => r.id === selected)!,
    world = pair[activeLane],
    modelCount = pair.a.metrics.jevAccepted + pair.b.metrics.jevAccepted;
  return (
    <div className="live-crowd">
      <header className="lc-intro">
        <div>
          <span className="lc-kicker">A living language experiment</span>
          <h2>
            A notice can change
            <br />
            <em>an afternoon.</em>
          </h2>
          <p>
            Twelve neighbors, their own little plans. Change the words on the
            board and watch who finds a reason to move.
          </p>
        </div>
        <div className="lc-afternoon">
          <span className={`lc-weather ${pair.a.weather}`} aria-hidden="true">
            {pair.a.weather === "rain" ? <CloudRain /> : <Sun />}
          </span>
          <strong>Bramble Square</strong>
          <span>
            {pair.a.eventUntil > pair.a.time
              ? pair.a.event
              : "A slow afternoon"}
          </span>
          <small>
            Fictional people ·{" "}
            {pair.a.modelMode === "recorded" && pair.b.modelMode === "recorded"
              ? "one recorded plan · two replays"
              : modelCount
                ? `${modelCount} accepted actor plans`
                : "local policies running"}
          </small>
        </div>
      </header>
      <div className="lc-recorded-demo">
        <button onClick={playRecorded}>
          <Play size={12} /> Watch a recorded Jev afternoon
        </button>
        <span>
          One real notice · 12 resident plans · replayed instantly, not live
        </span>
      </div>
      <div className="lc-controls">
        <div className="lc-transport">
          <button
            className="lc-play"
            onClick={toggle}
            aria-label={
              playing && live
                ? "Pause courtyard"
                : live
                  ? "Play courtyard"
                  : "Branch and play from checkpoint"
            }
          >
            {playing && live ? <Pause size={16} /> : <Play size={16} />}
            <span>
              {playing && live ? "Pause" : live ? "Play" : "Play a new branch"}
            </span>
          </button>
          <span className="lc-clock" data-testid="crowd-clock">
            {time(pair.a.time)}
          </span>
          <label className="lc-speed">
            Pace
            <select
              aria-label="Simulation speed"
              value={speed}
              onChange={(e) => {
                const n = Number(e.target.value);
                setSpeed(n);
                rate.current = n;
              }}
            >
              <option value={0.5}>½×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
            </select>
          </label>
        </div>
        <div className="lc-compare-actions">
          {pair.a.controller === "jev" && pair.b.controller === "jev" && (
            <button
              disabled={!live || pending.a || pending.b}
              onClick={() => {
                void ask("a");
                void ask("b");
              }}
            >
              <Sparkles size={13} /> Ask both
            </button>
          )}
          <button onClick={() => fork(true)}>
            <GitBranch size={14} /> Compare Jev fallback
          </button>
          <button
            className="lc-icon"
            aria-label="Start a fresh afternoon and preserve this run"
            onClick={restart}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>
      <div className="lc-worlds">
        {(["a", "b"] as const).map((lane, index) => {
          const w = pair[lane];
          return (
            <section
              className={`lc-world ${activeLane === lane ? "active" : ""}`}
              key={lane}
              aria-label={`Courtyard ${index + 1}`}
            >
              <div className="lc-world-head">
                <span className="lc-lane">{index + 1}</span>
                <div>
                  <label>
                    Controller
                    <select
                      aria-label={`Controller for courtyard ${index + 1}`}
                      disabled={!live}
                      value={w.controller}
                      onChange={(e) =>
                        configure(lane, e.target.value as Controller)
                      }
                    >
                      {Object.entries(titles).map(([id, t]) => (
                        <option key={id} value={id}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="lc-fallback">
                  <input
                    type="checkbox"
                    disabled={!live || w.controller !== "jev"}
                    checked={w.assisted}
                    onChange={(e) =>
                      configure(lane, w.controller, e.target.checked)
                    }
                  />
                  Local fallback
                </label>
              </div>
              <div className="lc-scene">
                <canvas
                  ref={(el) => {
                    canvases.current[lane] = el;
                  }}
                  aria-label={`Illustrated courtyard ${index + 1}. Use the resident buttons below to inspect and direct people.`}
                  role="img"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect(),
                      id = hitResident(
                        displayed()[lane],
                        ((e.clientX - rect.left) / rect.width) * VIEW.width,
                        ((e.clientY - rect.top) / rect.height) * VIEW.height,
                      );
                    if (id) selectResident(id, lane);
                  }}
                />
                <div className="lc-scene-badge">
                  {!live
                    ? "Checkpoint replay"
                    : pending[lane]
                      ? "Jev is reading · world keeps moving"
                      : w.controller === "jev"
                        ? `${w.modelMode === "recorded" ? "Recorded Jev" : "Live Jev"} · ${w.assisted ? "local fallback" : "wait between plans"}`
                        : titles[w.controller]}
                </div>
              </div>
              <div className="lc-world-foot">
                <span>
                  <i
                    className={`lc-dot ${w.controller === "jev" ? "jev" : ""}`}
                  />
                  {w.controller === "jev"
                    ? `${w.metrics.jevAccepted} Jev · ${w.metrics.fallbackChoices} fallback choices`
                    : `${w.metrics.visits} visits · ${welfare(w)}% comfort`}
                </span>
                {w.controller === "jev" ? (
                  <button
                    disabled={!live || pending[lane]}
                    onClick={() => void ask(lane)}
                  >
                    <Sparkles size={12} />
                    {pending[lane] ? "Reading…" : "Ask Jev to plan"}
                  </button>
                ) : (
                  <span className="lc-small">
                    {w.controller === "notice"
                      ? "Keyword baseline, not Jev"
                      : "Code chooses destinations"}
                  </span>
                )}
              </div>
              <p className="lc-current-notice">
                <span>On the board</span>
                {w.notice}
              </p>
            </section>
          );
        })}
      </div>
      <div className="lc-timeline">
        <div>
          <span>
            <Clock size={12} />
            {live ? "Live afternoon" : `Checkpoint · ${time(pair.a.time)}`}
          </span>
          <div>
            {!live && <button onClick={returnLive}>Return to live</button>}
            <button onClick={() => fork()}>
              <GitBranch size={12} /> Preserve & branch here
            </button>
          </div>
        </div>
        <input
          aria-label="Replay courtyard timeline"
          type="range"
          min="0"
          max={Math.max(0, history.length - 1)}
          value={frame ?? history.length - 1}
          onChange={(e) => scrub(Number(e.target.value))}
        />
        <div className="lc-timeline-labels">
          <span>{time(history[0]?.at ?? 0)}</span>
          <span>{history.length} checkpoints · replay makes no requests</span>
          <span>{time(history.at(-1)?.at ?? 0)}</span>
        </div>
        {archives.current.length > 0 && (
          <div className="lc-branches">
            <span>Preserved afternoons · in this tab</span>
            {archives.current.map((a) => (
              <button
                className={archive === a.id ? "selected" : ""}
                key={a.id}
                onClick={() => openArchive(a.id)}
              >
                {a.label}
                <span>{time(a.frames.at(-1)?.at ?? 0)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="lc-bottom">
        <section className="lc-notice-editor">
          <div className="lc-section-label">
            <Volume2 size={14} /> The noticeboard
          </div>
          <h3>Say something worth stopping for.</h3>
          <textarea
            aria-label="Courtyard announcement"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={600}
            placeholder="Invite your neighbors, change a plan, or add a small complication…"
          />
          <div className="lc-presets">
            {NOTICES.map((n) => (
              <button key={n.label} onClick={() => setDraft(n.text)}>
                {n.label}
              </button>
            ))}
          </div>
          <div className="lc-post">
            <label>
              Post to
              <select
                aria-label="Courtyard announcement destination"
                value={postTo}
                onChange={(e) => setPostTo(e.target.value as typeof postTo)}
              >
                <option value="b">Courtyard 2</option>
                <option value="a">Courtyard 1</option>
                <option value="both">Both courtyards</option>
              </select>
            </label>
            <button
              className="lc-primary"
              disabled={!live || !draft.trim()}
              onClick={post}
            >
              Put it on the board <ArrowRight size={14} />
            </button>
          </div>
          <p className="lc-fine">
            Local notice rules use a small keyword list. Choose Jev for language
            meaning, exclusions and individual preferences. Posting to a Jev
            side makes one live batch using your connected key. Movement never
            waits.
          </p>
          {error && (
            <p role="alert" className="lc-error">
              {error}
            </p>
          )}
        </section>
        <section className="lc-residents">
          <div className="lc-section-label">
            <Users size={14} /> Meet the neighbors
          </div>
          <div className="lc-roster">
            {PERSONAS.map((r, i) => (
              <button
                key={r.name}
                aria-label={`Inspect ${r.name}`}
                aria-pressed={selected === `r${i}`}
                className={selected === `r${i}` ? "selected" : ""}
                onClick={() => selectResident(`r${i}`, activeLane)}
              >
                <span style={{ background: r.color }}>{r.name[0]}</span>
                {r.name}
              </button>
            ))}
          </div>
          <div className="lc-inspector-lanes">
            {(["a", "b"] as const).map((lane, i) => (
              <button
                key={lane}
                aria-pressed={activeLane === lane}
                onClick={() => {
                  active.current = lane;
                  setActiveLane(lane);
                }}
              >
                Courtyard {i + 1}
              </button>
            ))}
          </div>
          <button
            className="lc-person-heading"
            onClick={() => setInspector(!inspector)}
            aria-expanded={inspector}
          >
            <span>
              {person.name}
              <small>
                Courtyard {activeLane === "a" ? 1 : 2} ·{" "}
                {person.source === "jev"
                  ? `${person.provenance === "recorded" ? "Recorded" : "Live"} Jev destination`
                  : sourceNames[person.source]}
              </small>
            </span>
            <ChevronDown size={15} />
          </button>
          <p className="lc-story">{person.story}</p>
          <div className="lc-needs">
            {(["hunger", "rest", "company"] as const).map((n) => (
              <div key={n}>
                <span>
                  {n === "hunger"
                    ? "Could eat"
                    : n === "rest"
                      ? "Needs rest"
                      : "Wants company"}
                </span>
                <meter
                  min={0}
                  max={1}
                  value={person.needs[n]}
                  aria-label={`${person.name}: ${n}`}
                />
              </div>
            ))}
          </div>
          <p className="lc-thought">“{person.thought}”</p>
          {inspector && (
            <div className="lc-person-details">
              <p className="lc-reaction">
                {(
                  {
                    drawn_in: "Jev’s last reading: this invitation fits.",
                    not_for_me:
                      "Jev’s last reading: this is not their kind of gathering.",
                    carry_on:
                      "Jev’s last reading: carry on with the afternoon.",
                    uncertain: "Jev’s last reading: the invitation is unclear.",
                  } as Record<string, string>
                )[person.reaction] ?? person.reaction}
              </p>
              <div className="lc-tags">
                {person.traits.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
              <div className="lc-direct">
                <MousePointer2 size={13} />
                <label>
                  Send {person.name} to
                  <select
                    aria-label={`Send ${person.name} to a destination`}
                    disabled={!live}
                    value=""
                    onChange={(e) => {
                      if (
                        humanTarget(
                          pairRef.current![activeLane],
                          selected,
                          e.target.value as PlaceId,
                        )
                      ) {
                        capture("Human intervention");
                        bump();
                      }
                    }}
                  >
                    <option value="" disabled>
                      Choose a place…
                    </option>
                    {PLACES.map((p) => (
                      <option
                        key={p.id}
                        value={p.id}
                        disabled={!isOpen(world, p.id)}
                      >
                        {p.name}
                        {!isOpen(world, p.id) ? " · closed" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                className="lc-release"
                disabled={!live}
                onClick={() => {
                  releaseHuman(pairRef.current![activeLane], selected);
                  capture("Released to controller");
                  bump();
                }}
              >
                Return to controller
              </button>
              <p className="lc-fine">
                Your destination takes priority for 22 world seconds. Pending
                suggestions for this resident cannot overwrite it.
              </p>
              <p className="lc-fine">
                Recent visits:{" "}
                {person.memory.length
                  ? person.memory.map((id) => place(id).name).join(" → ")
                  : "The afternoon is just beginning."}
              </p>
            </div>
          )}
        </section>
      </div>
      <details className="lc-evidence">
        <summary>
          What is choosing, what is moving, and what is measured?
        </summary>
        <div className="lc-explanation">
          <p>
            Jev reads the notice, each fictional resident’s preferences, needs,
            recent visits and open destinations. It makes two independent typed
            choices per eligible resident: destination and relationship to the
            notice. Every resident question shares the same observation; answers
            do not depend on other answers.
          </p>
          <p>
            Code moves residents, separates collisions, queues seats, closes the
            stage in rain and changes needs. An assisted Jev lane uses the
            deterministic needs policy to choose a new target between Jev plans.
            An unassisted lane finishes an existing destination, then waits.
            Human control overrides both. A keyword-only local notice policy is
            also available.
          </p>
          <p>
            The saved quiet-afternoon example contains one actual 24-question
            Jev batch. It returned 12 valid resident plans. The replay applies
            that same plan to both identical frozen states, then compares
            fallback off/on. Original service latency was{" "}
            {Math.round(demo.result.response.service_latency_ms)} ms; playback
            applies the result instantly. The exact request, raw response and
            attempt are in the research record. No owner key enters this app.
          </p>
          <p>
            Both lanes use the same seeded weather/event schedule and
            synchronized world clock. The comparison button clones courtyard 1
            into both lanes before changing fallback settings. Comfort is a
            constructed needs score, not evidence of real human welfare or a
            claim that Jev predicts people. Same-state source attribution stays
            in the log. Repeated live calls may return different plans, so this
            interactive comparison is not a controlled causal benchmark.
          </p>
          <p>
            Requests expire after 18 world seconds, and check branch, epoch,
            notice revision and each actor’s intent version. Normal movement
            does not invalidate them. A new human target, completed visit,
            closed destination or restored branch can invalidate a reply. Replay
            and checkpoints never issue requests. Hidden tabs pause the world
            clock.
          </p>
        </div>
        <table>
          <caption>Current branch evidence</caption>
          <thead>
            <tr>
              <th>Measure</th>
              <th>Courtyard 1</th>
              <th>Courtyard 2</th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                "Live Jev choices",
                pair.a.metrics.liveAccepted ?? 0,
                pair.b.metrics.liveAccepted ?? 0,
              ],
              [
                "Recorded Jev choices",
                pair.a.metrics.recordedAccepted ?? 0,
                pair.b.metrics.recordedAccepted ?? 0,
              ],
              [
                "Stale actor replies",
                pair.a.metrics.stale,
                pair.b.metrics.stale,
              ],
              [
                "Rejected targets",
                pair.a.metrics.illegal,
                pair.b.metrics.illegal,
              ],
              [
                "Provider failures",
                pair.a.metrics.failed,
                pair.b.metrics.failed,
              ],
              [
                "New fallback targets",
                pair.a.metrics.fallbackChoices,
                pair.b.metrics.fallbackChoices,
              ],
              [
                "Fallback actor-seconds",
                Math.round(pair.a.metrics.fallbackActorSeconds),
                Math.round(pair.b.metrics.fallbackActorSeconds),
              ],
              [
                "Waiting actor-seconds",
                Math.round(pair.a.metrics.waitingActorSeconds),
                Math.round(pair.b.metrics.waitingActorSeconds),
              ],
              [
                "Completed visits",
                pair.a.metrics.visits,
                pair.b.metrics.visits,
              ],
            ].map((row) => (
              <tr key={String(row[0])}>
                {row.map((x, i) => (
                  <td key={i}>{x}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="lc-event-log">
          {world.log
            .slice(-12)
            .reverse()
            .map((e, i) => (
              <p key={`${e.at}-${i}`}>
                <time>{time(e.at)}</time>
                <span>{e.text}</span>
                <small>{e.source ?? e.kind}</small>
              </p>
            ))}
        </div>
        <div className="lc-request-receipts">
          <h4>
            Exact request receipts · courtyard {activeLane === "a" ? 1 : 2}
          </h4>
          {(world.requests ?? []).length === 0 ? (
            <p>No live request has been issued in this branch.</p>
          ) : (
            [...(world.requests ?? [])].reverse().map((receipt) => (
              <details key={receipt.id}>
                <summary>
                  {time(receipt.issuedAt)} · {receipt.status} ·{" "}
                  {Object.keys(receipt.ticket.actors).length} residents
                </summary>
                <pre>{JSON.stringify(receipt, null, 2)}</pre>
              </details>
            ))
          )}
        </div>
        <button
          className="lc-export"
          onClick={() =>
            download("bramble-square-branches.json", {
              format: "live-crowd-v1",
              current: copy(pairRef.current),
              checkpoints: frames.current,
              preserved: archives.current,
              description:
                "Fictional simulation. Local rules and live Jev source labels remain distinct. No key is included.",
            })
          }
        >
          <Download size={14} /> Download branches and decisions
        </button>
      </details>
    </div>
  );
}
