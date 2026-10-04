/**
 * The reef: a living ocean where every small fish decides for itself what to do next. By default
 * a tiny policy evolved inside this reef decides for every fish, ten times a second, free.
 * MobileBERT (in the browser) and Jev (on the visitor's own key) are the alternatives. The race
 * puts the chosen decider against a recorded Jev run on the same reef and the same heatwave.
 */
import { useEffect, useRef, useState } from "react";
import {
  ACTIONS,
  advance,
  applyDecisions,
  cohortAlive,
  createReef,
  dropFood,
  due,
  DURATION,
  STALE_AFTER,
  STEP,
  staleShare,
  traitMeans,
  trigger,
  view,
  type Action,
  type EventKind,
  type Fish,
  type World,
} from "../../live-worlds/ocean/engine";
import { BROWSER_MODEL, fromJev, JEV_BATCH, JEV_MODEL, jevRequest, USD_PER_TOKEN } from "../../live-worlds/ocean/models";
import { paint, hitFish, VIEW } from "../../live-worlds/ocean/render";
import { decideAll, POLICY_NAME, WEIGHT_COUNT } from "../../live-worlds/ocean/policy";
import evolved from "../../live-worlds/ocean/policy.json";
import { parseRecording, RACE, replayer, type Recording } from "../../live-worlds/ocean/replay";
import type { Decision } from "../../live-worlds/ocean/engine";
import { getApiKey, NO_KEY_MESSAGE, run, percent as pct } from "./api";
import { BuildThis } from "./build-this";
import { describeFailure, type Failure } from "./live-failure";
import { LiveFailure } from "./trust";
import "./ocean-reef.css";

type Model = "evolved" | "browser" | "jev";

/** The evolved policy decides every live fish every this many ticks: ten times a second. */
const POLICY_EVERY = 3;
type Race = {
  live: World;
  rep: ReturnType<typeof replayer>;
  heated: boolean;
  liveStale: number[];
  repStale: number[];
  startedAt: number;
  done: boolean;
};

const EVENTS: { kind: EventKind; label: string; about: string }[] = [
  { kind: "heatwave", label: "Heatwave", about: "Coral bleaches, plankton thins, fish burn energy faster." },
  { kind: "net", label: "Fishing net", about: "A net sweeps the reef. Fish hidden in healthy coral are safe." },
  { kind: "storm", label: "Storm", about: "Currents throw everyone around." },
  { kind: "bloom", label: "Plankton bloom", about: "Food everywhere, for a while." },
  { kind: "oil", label: "Oil spill", about: "Oil spreads from the surface and drains energy." },
];

const NAMES: Record<EventKind, string> = { heatwave: "heatwave", net: "fishing net", storm: "storm", bloom: "plankton bloom", oil: "oil spill" };

const ACTION_WORDS: Record<Action, string> = {
  school: "Swim with the school",
  forage: "Go and eat",
  hide: "Hide in coral",
  flee: "Flee",
  follow: "Follow a food call",
  signal: "Warn the others",
  rest: "Rest",
};


/** Jev's cost per minute, from the recorded run's measured batches. */
const JEV_USD_PER_MINUTE = 0.04;

function openSettings() {
  const details = document.querySelector<HTMLDetailsElement>("details:has(> summary[aria-label='Settings'])");

  if (!details) return;

  details.open = true;
  details.querySelector("summary")?.focus();
}

async function loadRecording(): Promise<Recording> {
  const r = await fetch("/ocean/jev-heatwave.jsonl.gz");

  if (!r.ok) throw new Error(String(r.status));

  // Some servers send the file with Content-Encoding: gzip and the browser has already
  // unzipped it; others send the raw bytes. Unzip only if the gzip magic bytes are still there.
  const bytes = new Uint8Array(await r.arrayBuffer());
  const zipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = zipped ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text() : new TextDecoder().decode(bytes);

  return parseRecording(text);
}

/** The free model, one shared worker per page. */
let worker: Worker | null = null;
const pending = new Map<number, (d: Decision | null) => void>();
let onDownload: (percent: number) => void = () => {};

function askBrowser(id: number, f: ReturnType<typeof view>) {
  if (!worker) {
    worker = new Worker(new URL("./ocean-model.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data;

      if (m.type === "download") return onDownload(m.percent);

      const done = pending.get(m.id);

      pending.delete(m.id);
      done?.(m.type === "decision" ? m.decision : null);
    };
  }

  return new Promise<Decision | null>((resolve) => {
    pending.set(id, resolve);
    worker?.postMessage({ id, view: f });
  });
}

function Spark({ w }: { w: World }) {
  const s = w.samples.slice(-240);

  if (s.length < 2) return <svg className="reef-spark" viewBox="0 0 240 60" aria-hidden="true" />;

  const max = Math.max(60, ...s.map((x) => x.fish));
  const pts = (k: "fish" | "sharks", scale: number) =>
    s.map((x, i) => `${((i / (s.length - 1)) * 240).toFixed(1)},${(58 - (x[k] / scale) * 54).toFixed(1)}`).join(" ");

  return (
    <svg className="reef-spark" viewBox="0 0 240 60" role="img" aria-label={`Fish alive over time, now ${s.at(-1)?.fish}`}>
      <polyline points={pts("fish", max)} className="reef-spark-fish" />
      <polyline points={pts("sharks", 8)} className="reef-spark-sharks" />
    </svg>
  );
}

function Bar({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="reef-bar">
      <span>{label}</span>
      <i className={tone}>
        <b style={{ width: pct(Math.max(0, Math.min(1, value))) }} />
      </i>
      <em>{pct(value)}</em>
    </div>
  );
}

function Inspector({ f, w, onClose }: { f: Fish; w: World; onClose: () => void }) {
  const age = w.time - f.decidedAt;
  const fresh = age <= STALE_AFTER;
  const probs = f.probabilities ? ACTIONS.filter((a) => f.probabilities?.[a] !== undefined) : [];

  return (
    <section className="reef-card reef-inspector" aria-label={`Fish ${f.id}`}>
      <header>
        <h3>
          Fish #{f.id} <small>gen {f.gen}</small>
        </h3>
        <button type="button" onClick={onClose} aria-label="Stop following">
          ×
        </button>
      </header>
      {!f.alive ? (
        <p className="reef-fine">Died: {f.cause}.</p>
      ) : (
        <>
          <p className="reef-now">
            <b>{ACTION_WORDS[f.action]}</b>
            <span className={fresh ? "reef-fresh" : "reef-stale"}>
              {Number.isFinite(age) ? `${fresh ? "decided" : "stale:"} ${age.toFixed(1)} s ago by ${f.decidedBy}` : "no decision yet"}
              {f.latencyMs !== null ? ` · ${f.latencyMs} ms` : ""}
            </span>
          </p>
          {probs.map((a) => (
            <Bar key={a} label={ACTION_WORDS[a]} value={f.probabilities?.[a] ?? 0} tone={a === f.action ? "on" : ""} />
          ))}
          <Bar label="Energy" value={f.energy} tone="energy" />
          <div className="reef-traits">
            <Bar label="Speed" value={f.traits.speed} />
            <Bar label="Sight" value={f.traits.sight} />
            <Bar label="Schooling" value={f.traits.school} />
            <Bar label="Thrift" value={f.traits.thrift} />
          </div>
          <p className="reef-fine">What it sees: “{viewWords(w, f)}”</p>
        </>
      )}
    </section>
  );
}

function viewWords(w: World, f: Fish) {
  const v = view(w, f);
  const bits = [`energy ${v.energy}`, v.predator ? `shark ${v.predator.distance} on the ${v.predator.side}` : "no shark in sight", `${v.neighbours} fish near`];

  if (v.food) bits.push(`${v.food} bits of food`);

  if (v.coral) bits.push(`${v.coral} coral`);

  return bits.join(", ");
}

export function OceanReef() {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const raceLeft = useRef<HTMLCanvasElement | null>(null);
  const raceRight = useRef<HTMLCanvasElement | null>(null);
  const world = useRef<World>(createReef(RACE.seed));
  const race = useRef<Race | null>(null);
  const recording = useRef<Recording | null>(null);
  const generation = useRef(0);
  const latencies = useRef<number[]>([]);
  /** [ms, decisions] samples of the decided world, for decisions a second. */
  const counts = useRef<[number, number][]>([]);
  const policyMicros = useRef<number[]>([]);
  const spent = useRef(0);
  // The latest batch sent to Jev, for "Build this".
  const lastJev = useRef<unknown>(null);
  const fps = useRef(0);
  const [, setVersion] = useState(0);
  const [model, setModel] = useState<Model>("evolved");
  const [running, setRunning] = useState(true);
  const [lens, setLens] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [download, setDownload] = useState<number | null>(null);
  const [error, setError] = useState("");
  /** Why live Jev stopped, and a counter that restarts its loop on "Try again". */
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [raceState, setRaceState] = useState<"idle" | "loading" | "running" | "done">("idle");
  const [baseline, setBaseline] = useState<{ alive: number; survived: number; cohort: number } | null>(null);
  const runningRef = useRef(running);
  const modelRef = useRef(model);

  runningRef.current = running;
  modelRef.current = model;
  onDownload = (p) => setDownload(p);

  const target = () => race.current?.live ?? world.current;

  /** Every live fish, decided now by the evolved policy; times it per fish. */
  const decideEvolved = (w: World) => {
    const t = performance.now();
    const ds = decideAll(w, evolved);

    applyDecisions(w, ds);

    if (ds.length) policyMicros.current = [...policyMicros.current.slice(-59), ((performance.now() - t) * 1000) / ds.length];
  };

  // The world clock and painting.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let frames = 0;
    let since = last;
    let lastUi = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);

      last = now;
      frames++;

      if (now - since > 1000) {
        fps.current = Math.round((frames * 1000) / (now - since));
        frames = 0;
        since = now;
      }

      if (runningRef.current) {
        acc += dt;

        for (let n = 0; acc >= STEP && n < 6; n++) {
          acc -= STEP;

          const r = race.current;

          if (r && !r.done) {
            if (!r.heated && r.live.time >= RACE.heatwaveAt) {
              r.heated = true;
              trigger(r.live, "heatwave");
            }

            if (modelRef.current === "evolved" && r.live.tick % POLICY_EVERY === 0) decideEvolved(r.live);

            advance(r.live);
            r.rep.step();

            if (r.live.tick % 30 === 0) {
              r.liveStale.push(staleShare(r.live));
              r.repStale.push(staleShare(r.rep.world));
            }

            if (r.live.time >= RACE.seconds) {
              r.done = true;
              setRaceState("done");
            }
          } else {
            if (modelRef.current === "evolved" && world.current.tick % POLICY_EVERY === 0) decideEvolved(world.current);

            advance(world.current);
          }
        }

        if (acc > STEP * 6) acc = 0;
      }

      const r = race.current;
      const opts = { lens, selected, reduced };

      if (r) {
        const a = raceLeft.current?.getContext("2d");
        const b = raceRight.current?.getContext("2d");

        if (a) paint(a, r.live, { ...opts, selected: null });

        if (b) paint(b, r.rep.world, { ...opts, selected: null });
      } else {
        const ctx = canvas.current?.getContext("2d");

        if (ctx) paint(ctx, world.current, opts);
      }

      if (now - lastUi > 250) {
        lastUi = now;
        counts.current = [...counts.current.filter(([t]) => t > now - 5000), [now, (race.current?.live ?? world.current).decisions]];
        setVersion((v) => v + 1);
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(raf);
  }, [lens, selected]);

  // The decision loop: asks the chosen model about the most urgent fish, forever, without
  // ever making the world wait. Restarts when the model or the target world changes.
  useEffect(() => {
    const gen = ++generation.current;
    const live = () => gen === generation.current;

    latencies.current = [];
    counts.current = [];

    // The evolved policy runs inside the clock loop; nothing to wait for here.
    if (model === "evolved") return;

    const loop = async () => {
      while (live()) {
        if (!runningRef.current || (race.current && race.current.done)) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }

        const w = target();

        if (model === "browser") {
          const f = due(w, 1)[0];

          if (!f) {
            await new Promise((r) => setTimeout(r, 50));
            continue;
          }

          const d = await askBrowser(f.id, view(w, f));

          if (!live()) return;

          setDownload(null);

          if (d && target() === w) {
            applyDecisions(w, [d]);
            latencies.current.push(d.latencyMs ?? 0);
          }
        } else {
          if (!getApiKey()) {
            setError("Add your gateway key in Settings to run Jev. The free deciders keep working without one.");
            return;
          }

          const views = due(w, JEV_BATCH).map((f) => view(w, f));

          if (!views.length) {
            await new Promise((r) => setTimeout(r, 50));
            continue;
          }

          try {
            const req = jevRequest(views);

            lastJev.current = req;
            const res = await run(req.state, req.questions);

            if (!live()) return;

            const ds = fromJev(views, res.answers ?? {}, res.latency_ms ?? null);

            if (target() === w) applyDecisions(w, ds);

            setFailure(null);
            spent.current += (res.usage?.input_tokens ?? 0) * USD_PER_TOKEN;
            latencies.current.push(res.latency_ms ?? 0);
          } catch (e) {
            const f = describeFailure(e, NO_KEY_MESSAGE);

            if (f.kind === "cancelled") return;

            setFailure(f);

            // Fish keep their last action meanwhile. A rejected key or a spent budget won't fix
            // itself, so stop asking until the visitor acts; otherwise wait as long as asked.
            if (!f.retryable) return;

            await new Promise((r) => setTimeout(r, f.retryAfterMs ?? 2000));
          }
        }

        latencies.current = latencies.current.slice(-60);
      }
    };

    void loop();

    return () => {
      generation.current++;
    };
  }, [model, raceState === "running", attempt]);

  const w = race.current?.live ?? world.current;
  const alive = w.fish.filter((f) => f.alive);
  const c = counts.current;
  const rate = c.length > 1 ? ((c[c.length - 1][1] - c[0][1]) * 1000) / Math.max(1, c[c.length - 1][0] - c[0][0]) : 0;
  const micros = policyMicros.current.length ? [...policyMicros.current].sort((a, b) => a - b)[Math.floor(policyMicros.current.length / 2)] : null;
  const median = latencies.current.length ? [...latencies.current].sort((a, b) => a - b)[Math.floor(latencies.current.length / 2)] : null;
  const means = traitMeans(w);
  const active = world.current.events.find((e) => world.current.time < e.end + 10 && !e.reported);
  const outcome = world.current.outcomes.at(-1);
  const sel = selected === null ? null : world.current.fish.find((f) => f.id === selected) ?? null;
  const decider = model === "evolved" ? POLICY_NAME : model === "browser" ? BROWSER_MODEL : JEV_MODEL;

  const startRace = async () => {
    setRaceState("loading");
    setError("");

    try {
      recording.current ??= await loadRecording();
    } catch {
      setError("The recorded Jev run could not be loaded.");
      setRaceState("idle");

      return;
    }

    race.current = { live: createReef(RACE.seed), rep: replayer(recording.current), heated: false, liveStale: [], repStale: [], startedAt: performance.now(), done: false };
    setSelected(null);
    setRaceState("running");

    // The no-decision baseline: the same reef where every fish keeps schooling.
    setTimeout(() => {
      const b = createReef(RACE.seed);

      while (b.time < RACE.seconds) {
        if (Math.abs(b.time - RACE.heatwaveAt) < STEP / 2) trigger(b, "heatwave");

        advance(b);
      }

      const o = b.outcomes[0];

      setBaseline({ alive: b.fish.filter((f) => f.alive).length, survived: o?.survived ?? 0, cohort: o?.cohort ?? 0 });
    }, 50);
  };

  const endRace = () => {
    race.current = null;
    setRaceState("idle");
  };

  const share = outcome
    ? `The reef after the ${NAMES[outcome.kind]}: ${pct(outcome.survived / Math.max(1, outcome.cohort))} survived (${outcome.survived} of ${outcome.cohort} fish), decided by ${decider}. ${location.origin}/#experiment/ocean`
    : "";

  const r = race.current;
  const raceRow = (label: string, rw: World, stale: number[], rateText: string) => {
    const o = rw.outcomes[0];

    return (
      <tr>
        <th scope="row">{label}</th>
        <td>{rateText}</td>
        <td>{stale.length ? pct(stale.reduce((a, b) => a + b, 0) / stale.length) : "—"}</td>
        <td>{o ? `${pct(o.survived / Math.max(1, o.cohort))} (${o.survived} of ${o.cohort})` : "—"}</td>
        <td>{rw.fish.filter((f) => f.alive).length}</td>
      </tr>
    );
  };

  return (
    <div className="toybox reef">
      <div className="reef-head">
        <p className="reef-lede">
          {alive.length} fish choose what to do next from what they can see: school, eat, hide, flee or warn the others.
        </p>
        <div className="reef-models" role="group" aria-label="Who decides">
          <button type="button" aria-pressed={model === "evolved"} onClick={() => setModel("evolved")}>
            {POLICY_NAME} <small>{WEIGHT_COUNT} weights, free</small>
          </button>
          <button type="button" aria-pressed={model === "browser"} onClick={() => setModel("browser")}>
            {BROWSER_MODEL} <small>in your browser, free</small>
          </button>
          <button
            type="button"
            aria-pressed={model === "jev"}
            onClick={() => {
              setError("");

              if (!getApiKey()) {
                setError("Add your gateway key in Settings to run Jev. The free deciders keep working without one.");

                return;
              }

              setModel("jev");
            }}
          >
            Jev <small>your key, about ${JEV_USD_PER_MINUTE.toFixed(2)} a minute</small>
          </button>
        </div>
      </div>

      {failure && model === "jev" && (
        <LiveFailure
          failure={failure}
          fallback="Fish keep their last action until a new decision arrives. The evolved policy can take over, free."
          onRetry={() => {
            setFailure(null);
            setAttempt((n) => n + 1);
          }}
          alt={{ label: "Use the evolved policy", onClick: () => setModel("evolved") }}
        />
      )}

      {error && (
        <p className="reef-note" role="alert">
          {error}{" "}
          {!getApiKey() && (
            <button type="button" className="reef-link" onClick={openSettings}>
              Open Settings
            </button>
          )}
        </p>
      )}

      {!r ? (
        <>
          <div className="reef-events" role="group" aria-label="Events">
            {EVENTS.map((e) => (
              <button key={e.kind} type="button" title={e.about} disabled={!!world.current.events.find((x) => x.kind === e.kind && world.current.time < x.end)} onClick={() => trigger(world.current, e.kind)}>
                {e.label}
              </button>
            ))}
          </div>

          <div className="reef-stage">
            <canvas
              ref={canvas}
              width={VIEW.width}
              height={VIEW.height}
              className="reef-canvas"
              data-fps={fps.current}
              role="img"
              aria-label={`The reef: ${alive.length} fish. Tap a fish to follow it, or tap the water to drop food.`}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * VIEW.width;
                const y = ((e.clientY - rect.top) / rect.height) * VIEW.height;
                const f = hitFish(world.current, x, y);

                if (f) setSelected(f.id);
                else dropFood(world.current, x, y);
              }}
            />
            {active && (
              <p className="reef-banner" aria-live="polite">
                {world.current.time < active.end ? `${EVENTS.find((e) => e.kind === active.kind)?.label} · ${Math.ceil(active.end - world.current.time)} s left` : "Counting survivors…"}{" "}
                · {cohortAlive(world.current, active)} of {active.cohort.length} still alive
              </p>
            )}
            <p className="reef-hint">Tap a fish to follow it. Tap the water to drop food.</p>
          </div>

          {outcome && (
            <div className="reef-card reef-win" role="status">
              <b>
                The reef after the {NAMES[outcome.kind]}: {pct(outcome.survived / Math.max(1, outcome.cohort))} survived
              </b>
              <p>
                {outcome.survived} of the {outcome.cohort} fish alive when it started were still alive 10 s after it ended.
                Decisions by {decider}.
              </p>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(share).then(() => setCopied(true))}>
                {copied ? "Copied" : "Copy the card"}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="reef-race">
          <div>
            <h3>
              {decider} {model === "jev" ? "on your key, live" : "in your browser, live"}
            </h3>
            <canvas ref={raceLeft} width={VIEW.width} height={VIEW.height} className="reef-canvas" aria-label="The reef on your model" />
          </div>
          <div>
            <h3>Jev, recorded {recording.current?.recordedAt.slice(0, 10)}</h3>
            <canvas ref={raceRight} width={VIEW.width} height={VIEW.height} className="reef-canvas" aria-label="The same reef, replayed from Jev's recorded run" />
          </div>
          <p className="reef-banner reef-race-clock" aria-live="polite">
            {r.done ? "Done." : r.live.time < RACE.heatwaveAt ? `Heatwave in ${Math.ceil(RACE.heatwaveAt - r.live.time)} s` : `${Math.ceil(RACE.seconds - r.live.time)} s left`}
          </p>
        </div>
      )}

      <div className="reef-panels">
        <section className="reef-card">
          <h3>Who's deciding</h3>
          <p className="reef-big">
            {rate.toFixed(0)} <small>decisions a second</small>
          </p>
          <p className="reef-fine">
            {decider}
            {model === "evolved" && micros !== null ? ` · ${micros < 10 ? micros.toFixed(1) : micros.toFixed(0)} µs per fish, every fish ten times a second` : ""}
            {model !== "evolved" && median !== null ? ` · median ${median} ms ${model === "jev" ? "per batch of up to 40 fish" : "per fish"}` : ""}
            {download !== null ? ` · downloading the model (27 MB, once) ${download}%` : ""}
            {model === "jev" ? ` · $${spent.current.toFixed(4)} so far` : " · $0"}
          </p>
          <Bar label="Stale" value={staleShare(w)} tone="stale" />
          <BuildThis
            key={model}
            load={async () => {
              const now = target();
              const fish = due(now, JEV_BATCH);

              return model === "jev" && lastJev.current
                ? lastJev.current
                : jevRequest((fish.length ? fish : now.fish.filter((f) => f.alive).slice(0, JEV_BATCH)).map((f) => view(now, f)));
            }}
            rebuilt={model !== "jev"}
            note={model === "jev" ? undefined : "These fish aren't deciding with Jev; this is the batch Jev gets for up to 40 of them as the reef is now."}
            label="Build this: one batch of fish"
          />
          <label className="reef-lens">
            <input type="checkbox" checked={lens} onChange={(e) => setLens(e.target.checked)} /> Latency lens: grey out fish acting
            on a decision more than {STALE_AFTER} s old
          </label>
        </section>

        <section className="reef-card">
          <h3>The reef</h3>
          <Spark w={w} />
          <p className="reef-fine">
            {alive.length} fish · {w.sharks.filter((s) => s.alive).length} sharks · {w.births} born · {w.deaths.eaten} eaten ·{" "}
            {w.deaths.starved} starved{w.deaths.net ? ` · ${w.deaths.net} netted` : ""}
            {w.deaths.oil ? ` · ${w.deaths.oil} lost to oil` : ""} · deepest generation{" "}
            {Math.max(0, ...alive.map((f) => f.gen))}
          </p>
          <div className="reef-traits">
            <Bar label="Speed" value={means.speed} />
            <Bar label="Sight" value={means.sight} />
            <Bar label="Schooling" value={means.school} />
            <Bar label="Thrift" value={means.thrift} />
          </div>
          <p className="reef-fine">Average traits of the living. Young inherit their parent's, with small mutations; speed and sight cost energy.</p>
        </section>

        {sel && !r ? (
          <Inspector f={sel} w={world.current} onClose={() => setSelected(null)} />
        ) : (
          <section className="reef-card">
            <h3>Race the models</h3>
            <p>
              Same reef, same heatwave at {RACE.heatwaveAt} s, {RACE.seconds} s each. Your {decider} runs live; Jev's run was
              recorded.
            </p>
            {raceState === "idle" && (
              <button type="button" className="reef-go" onClick={() => void startRace()}>
                Start the race
              </button>
            )}
            {raceState === "loading" && <p className="reef-fine">Loading Jev's run…</p>}
            {r && (
              <>
                <div className="reef-table">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Decider</th>
                        <th scope="col">Decisions/s</th>
                        <th scope="col">Stale</th>
                        <th scope="col">Heatwave survivors</th>
                        <th scope="col">Alive</th>
                      </tr>
                    </thead>
                    <tbody>
                      {raceRow(`${decider} (live)`, r.live, r.liveStale, (r.live.decisions / Math.max(1, r.live.time)).toFixed(0))}
                      {raceRow("Jev (recorded)", r.rep.world, r.repStale, (r.rep.world.decisions / Math.max(1, r.rep.world.time)).toFixed(0))}
                      {baseline && r.done && (
                        <tr>
                          <th scope="row">Nobody decides</th>
                          <td>0</td>
                          <td>100%</td>
                          <td>{`${pct(baseline.survived / Math.max(1, baseline.cohort))} (${baseline.survived} of ${baseline.cohort})`}</td>
                          <td>{baseline.alive}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {r.done && <p className="reef-fine">One run each. Another seed, or another computer, can come out differently.</p>}
                <button type="button" className="reef-go" onClick={endRace}>
                  {r.done ? "Back to the reef" : "Stop the race"}
                </button>
              </>
            )}
          </section>
        )}
      </div>

      <details className="reef-more">
        <summary>How it works, and what one recorded run showed</summary>
        <p>
          Code moves every fish, runs hunger, sharks, coral, births and events. A model only chooses each small fish's next
          action from what it can see, among the options that make sense right then: it can't choose to hide with no healthy
          coral nearby. A fish keeps its last action until a new decision arrives; the world never waits. The most urgent
          fish (old decisions, a shark in view) are asked first, the same rule for every model.
        </p>
        <p>
          Jev gets up to 40 fish per request, each as its own typed choice. {BROWSER_MODEL} (27 MB, running in a worker in
          your browser) reads one fish at a time: its view is the premise, each action a hypothesis.
        </p>
        <p>
          The default decider is a tiny policy evolved inside this reef: {WEIGHT_COUNT} weights, trained only on how many
          fish survive, never on any model's answers. On 20 test reefs it never trained on, it kept 89% of fish alive
          through a heatwave and 82% through a fishing net, against 79% and 9% when nobody decides and 78% and 4% for{" "}
          {BROWSER_MODEL} at the 5 decisions a second it manages in a browser. A short hand-written rule still does
          better on heatwaves (94%), nets (85%) and oil spills (90%; the policy never saw oil and kept 85%). Speed matters
          as much as the decider: held to 5 decisions a second, the evolved policy keeps only 57% through a heatwave,
          fewer than leaving every fish alone. Full numbers are in live-worlds/ocean/heldout.json.
        </p>
        <p>
          On 1 Oct 2026 the race reef ran once on Jev: 148 requests, $0.038, about 92 decisions a second. 98 of 110 fish
          (89%) made it through the heatwave, and 120 were alive at 60 s. The race replays exactly that run; the other lane
          and the “nobody decides” row run in your browser. These are single runs, not evidence that one model keeps fish
          alive better in general.
        </p>
      </details>
    </div>
  );
}
