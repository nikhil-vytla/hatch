/**
 * The rumour mill: pin a rumour on one street of Bramble (4,000 fictional residents) and watch
 * it spread neighbour to neighbour. Each resident who hears it acts on one draw from their
 * profile's answer. The free model is similarity in your browser; Jev runs on your own key, or
 * from a recording for the £500 scam.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  advance,
  believes,
  counts,
  createWorld,
  keyFor,
  pin,
  position,
  settled,
  simulate,
  Status,
  waitingProfiles,
  type Counts,
  type Track,
  type World,
} from "../../live-worlds/rumour/engine";
import { PRESETS } from "../../live-worlds/rumour/presets";
import { allProfiles, jevRequest, toDist, type Dist, type MessageKind, type Profile } from "../../live-worlds/rumour/profiles";
import { features, profileDist, type Vectors } from "../../live-worlds/rumour/similarity";
import { ARCHETYPES, createTown, PLACES, VIEW, type PlaceId, type Town } from "../../live-worlds/rumour/town";
import vectorsDoc from "../../live-worlds/rumour/vectors.json";
import recordedRaw from "../../live-worlds/rumour/jev-scam.jsonl?raw";
import { getApiKey, run } from "./api";
import "./rumour-mill.css";

type ModelId = "free" | "jev" | "recorded";

const MODEL_NAMES: Record<ModelId, string> = {
  free: "MiniLM (free, in your browser)",
  jev: "Jev (your key)",
  recorded: "Jev (recorded run)",
};

// TypeSafe's list price: $0.042 per million input tokens, output free.
const USD_PER_TOKEN = 0.042 / 1e6;

/** Measured on the recording: about 118 input tokens per profile question. */
const TOKENS_PER_PROFILE = 118;

const vectors: Vectors = {
  anchors: vectorsDoc.anchors,
  archetypes: vectorsDoc.archetypes,
  places: vectorsDoc.places,
} as Vectors;

const presetVectors: Record<string, number[]> = vectorsDoc.messages;

type RecordedRow = { kind: MessageKind; latencyMs: number; answers: Record<string, { probabilities?: Record<string, number> } | null> };

const recorded: RecordedRow[] = recordedRaw
  .trim()
  .split("\n")
  .map((l: string) => JSON.parse(l));

const COLOURS = {
  unaware: "#d8ccb6",
  thinking: "#ffd23f",
  believe: "#f0532d",
  argue: "#1f4fbf",
  ignore: "#a99d86",
  corrected: "#1c8a5a",
};

/** A notice that names a place lets residents go there. */
function placeIn(text: string): PlaceId | null {
  const t = text.toLowerCase();
  const words: [PlaceId, string[]][] = [
    ["bakery", ["bakery", "baker"]],
    ["hall", ["town hall", "council", "mayor"]],
    ["market", ["market"]],
    ["bridge", ["bridge"]],
    ["stage", ["bandstand", "gig", "concert"]],
    ["library", ["library"]],
    ["school", ["school"]],
    ["pub", ["pub", "the crown"]],
  ];

  for (const [id, ws] of words) if (ws.some((w) => t.includes(w))) return id === "hall" && !/\b(come|meet|join|at the)\b/.test(t) ? null : id;

  return null;
}

function freeAnswers(vector: number[], kind: MessageKind, place: PlaceId | null) {
  const f = features(vector, vectors);

  return new Map(allProfiles(kind).map((p) => [p.key, profileDist(f, p, kind, place)]));
}

function recordedAnswers(kind: MessageKind) {
  const m = new Map<string, Dist>();

  for (const row of recorded.filter((r) => r.kind === kind))
    for (const [k, a] of Object.entries(row.answers)) {
      const d = toDist(a?.probabilities);

      if (d) m.set(k, d);
    }

  return m;
}

type Stats = { model: ModelId; calls: number; ms: number[]; tokens: number; scoredIn: number | null };

function blockAt(town: Town, x: number, y: number) {
  return town.blocks.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)?.id ?? null;
}

let embedWorker: Worker | null = null;
const embedJobs = new Map<string, { resolve: (v: { vector: number[]; ms: number }) => void; reject: (e: Error) => void; progress: (p: number) => void }>();

function embed(text: string, progress: (p: number) => void) {
  if (!embedWorker) {
    embedWorker = new Worker(new URL("./rumour-embed.worker.ts", import.meta.url), { type: "module" });
    embedWorker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      const job = embedJobs.get(m.id);

      if (!job) return;

      if (m.type === "download") job.progress(m.percent);
      else {
        embedJobs.delete(m.id);

        if (m.type === "vector") job.resolve({ vector: m.vector, ms: m.ms });
        else job.reject(new Error(m.message ?? "The in-browser model failed."));
      }
    };
  }

  const id = `${Date.now()}-${Math.random()}`;

  return new Promise<{ vector: number[]; ms: number }>((resolve, reject) => {
    embedJobs.set(id, { resolve, reject, progress });
    embedWorker?.postMessage({ id, text });
  });
}

function paintBase(ctx: CanvasRenderingContext2D, town: Town) {
  ctx.fillStyle = "#fff4e0";
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  // The river and its bridge.
  ctx.fillStyle = "#a9cdfc";
  ctx.fillRect(598, 0, 70, VIEW.height);
  ctx.fillStyle = "#e2cda6";
  ctx.fillRect(590, 318, 86, 26);

  for (const b of town.blocks) {
    ctx.fillStyle = "#fbe9c9";
    ctx.strokeStyle = "#e2cda6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, 10);
    ctx.fill();
    ctx.stroke();
  }
}

function paintPlaces(ctx: CanvasRenderingContext2D, highlight: PlaceId | null) {
  ctx.font = "800 13px Nunito, system-ui, sans-serif";
  ctx.textBaseline = "middle";

  for (const p of PLACES) {
    const label = p.name.replace(/^the /, "");
    const w = ctx.measureText(label).width + 16;

    ctx.fillStyle = p.id === highlight ? "#ffd23f" : "#ffffff";
    ctx.strokeStyle = "#17140f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(p.x - w / 2, p.y - 11, w, 22, 11);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#17140f";
    ctx.fillText(label, p.x - w / 2 + 8, p.y + 1);
  }
}

function colourOf(w: World, id: number) {
  const t = w.rumour;

  if (!t || t.status[id] === Status.Unaware) return COLOURS.unaware;

  if (believes(w.counter, id)) return COLOURS.corrected;

  if (t.status[id] === Status.Thinking) return COLOURS.thinking;

  if (believes(t, id)) return COLOURS.believe;

  return t.action[id] === "argue" ? COLOURS.argue : COLOURS.ignore;
}

/** Believers over time for one model's answers, simulated instantly on the same town and seed. */
function curveFor(town: Town, preset: (typeof PRESETS)[number], answers: Map<string, Dist>) {
  return simulate(town, "rumour", preset.text, preset.place, preset.block, answers, 1, 60).curve;
}

function Curve({ lines }: { lines: { name: string; colour: string; points: { t: number; believe: number }[] }[] }) {
  const w = 320;
  const h = 120;
  const maxT = Math.max(10, ...lines.flatMap((l) => l.points.map((p) => p.t)));
  const maxY = Math.max(100, ...lines.flatMap((l) => l.points.map((p) => p.believe)));
  const path = (pts: { t: number; believe: number }[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${((p.t / maxT) * (w - 10) + 5).toFixed(1)},${(h - 18 - (p.believe / maxY) * (h - 30)).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="rm-curve" role="img" aria-label="Believers over time">
      <line x1={5} y1={h - 18} x2={w - 5} y2={h - 18} stroke="#17140f" strokeWidth={1.5} />
      {lines.map((l) => (
        <path key={l.name} d={path(l.points)} fill="none" stroke={l.colour} strokeWidth={3} strokeLinejoin="round" />
      ))}
      <text x={5} y={h - 4} className="rm-curve-label">
        0 s
      </text>
      <text x={w - 5} y={h - 4} textAnchor="end" className="rm-curve-label">
        {Math.round(maxT)} s
      </text>
      <text x={8} y={12} className="rm-curve-label">
        {maxY.toLocaleString()} believe
      </text>
    </svg>
  );
}

export function RumourMill() {
  const town = useMemo(() => createTown(7, 4000), []);
  const worldRef = useRef<World>(createWorld(town, 1));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const [presetId, setPresetId] = useState("cake");
  const [text, setText] = useState(PRESETS[0].text);
  const [counterText, setCounterText] = useState(PRESETS[0].counter);
  const [block, setBlock] = useState(PRESETS[0].block);
  const [model, setModel] = useState<ModelId>("free");
  const [selected, setSelected] = useState<number | null>(null);
  const [c, setC] = useState<Counts>(counts(worldRef.current));
  const [stats, setStats] = useState<Stats>({ model: "free", calls: 0, ms: [], tokens: 0, scoredIn: null });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fps, setFps] = useState(0);
  const runId = useRef(0);
  const requested = useRef<Record<MessageKind, Set<string>>>({ rumour: new Set(), counter: new Set() });
  const inFlight = useRef(0);

  const preset = PRESETS.find((p) => p.id === presetId);
  const isPreset = !!preset && text === preset.text;
  const recordedOk = presetId === "scam" && isPreset;

  const compare = useMemo(() => {
    const scam = PRESETS.find((p) => p.id === "scam");

    if (!scam) return null;

    return {
      free: curveFor(town, scam, freeAnswers(presetVectors[scam.text], "rumour", scam.place)),
      jev: curveFor(town, scam, recordedAnswers("rumour")),
    };
  }, [town]);

  // Jev, live: ask for profiles as residents start waiting on them, a batch at a time.
  const pump = (kind: MessageKind, t: Track, id: number) => {
    const w = worldRef.current;

    if (runId.current !== id || inFlight.current >= 3) return;

    const keys = waitingProfiles(w, t).filter((k) => !requested.current[kind].has(k));

    if (!keys.length) return;

    const byKey = new Map(allProfiles(kind).map((p) => [p.key, p]));
    const batch = keys
      .slice(0, 100)
      .map((k) => byKey.get(k))
      .filter((p): p is Profile => !!p);

    for (const p of batch) requested.current[kind].add(p.key);

    inFlight.current++;

    const req = jevRequest(batch, kind, t.message.text, kind === "counter" ? (w.rumour?.message.text ?? null) : null, t.message.place);

    run(req.state, req.questions)
      .then((r) => {
        if (runId.current !== id) return;

        for (const [i, p] of batch.entries()) {
          const d = toDist(r.answers?.[`p${i}`]?.probabilities);

          // A missing answer leaves those residents ignoring it rather than stuck.
          t.answers.set(p.key, d ?? { ignore: 1, share: 0, go: 0, argue: 0 });
        }

        setStats((s) => ({ ...s, calls: s.calls + 1, ms: [...s.ms, r.latency_ms ?? 0], tokens: s.tokens + (r.usage?.input_tokens ?? 0) }));
      })
      .catch((e: unknown) => {
        if (runId.current !== id) return;

        for (const p of batch) requested.current[kind].delete(p.key);

        setNote(e instanceof Error ? e.message : "Jev could not be reached.");
      })
      .finally(() => {
        inFlight.current--;
      });
  };

  async function answersFor(kind: MessageKind, message: string, place: PlaceId | null, m: ModelId, id: number) {
    if (m === "recorded") return recordedAnswers(kind);

    if (m === "jev") return new Map<string, Dist>();

    const known = presetVectors[message];

    if (known) {
      const t0 = performance.now();
      const a = freeAnswers(known, kind, place);

      setStats((s) => ({ ...s, scoredIn: performance.now() - t0 }));

      return a;
    }

    setNote("Loading the free model…");

    const { vector } = await embed(message, (p) => runId.current === id && setNote(`Downloading the free model (23 MB, once) · ${p}%`));
    const t0 = performance.now();
    const a = freeAnswers(vector, kind, place);

    setStats((s) => ({ ...s, scoredIn: performance.now() - t0 }));
    setNote("");

    return a;
  }

  async function start(message: string, where: number, m: ModelId, place: PlaceId | null) {
    const id = ++runId.current;
    const w = createWorld(town, 1);

    worldRef.current = w;
    requested.current = { rumour: new Set(), counter: new Set() };
    setDone(false);
    setCopied(false);
    setSelected(null);
    setStats({ model: m, calls: 0, ms: [], tokens: 0, scoredIn: null });
    setNote("");

    if (m === "jev" && !getApiKey()) {
      setNote("Add your gateway key in Settings to run Jev live. The free model needs no key.");

      return;
    }

    setBusy(true);

    const t = pin(w, "rumour", message, place, where);

    try {
      const answers = await answersFor("rumour", message, place, m, id);

      if (runId.current !== id) return;

      for (const [k, d] of answers) t.answers.set(k, d);

      if (m === "recorded") setStats((s) => ({ ...s, calls: recorded.filter((r) => r.kind === "rumour").length, ms: recorded.filter((r) => r.kind === "rumour").map((r) => r.latencyMs) }));
    } catch (e) {
      setNote(e instanceof Error ? e.message : "The free model could not load.");
    } finally {
      if (runId.current === id) setBusy(false);
    }
  }

  async function correct() {
    const w = worldRef.current;

    if (!w.rumour) return;

    const id = runId.current;
    const t = pin(w, "counter", counterText, null, w.rumour.message.block);

    try {
      const answers = await answersFor("counter", counterText, null, stats.model, id);

      if (runId.current !== id) return;

      for (const [k, d] of answers) t.answers.set(k, d);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "The free model could not load.");
    }

    setDone(false);
  }

  // Start the default rumour on load, so the town is moving within a second.
  useEffect(() => {
    void start(PRESETS[0].text, PRESETS[0].block, "free", PRESETS[0].place);
  }, []);

  // The loop: advance the world, draw it, publish counts a few times a second.
  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);

    canvas.width = VIEW.width * dpr;
    canvas.height = VIEW.height * dpr;

    const ctx = canvas.getContext("2d");
    const base = document.createElement("canvas");

    base.width = canvas.width;
    base.height = canvas.height;

    const bctx = base.getContext("2d");

    if (!ctx || !bctx) return;

    bctx.scale(dpr, dpr);
    paintBase(bctx, town);
    baseRef.current = base;

    let raf = 0;
    let last = performance.now();
    let lastPublish = 0;
    let frames = 0;
    let frameClock = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const frame = (now: number) => {
      const w = worldRef.current;
      const dt = Math.min(0.1, (now - last) / 1000);

      last = now;
      advance(w, dt);

      for (const [kind, t] of [["rumour", w.rumour], ["counter", w.counter]] as const)
        if (t && stats.model === "jev") pump(kind, t, runId.current);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(base, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const buckets = new Map<string, number[]>();

      for (let i = 0; i < town.residents.length; i++) {
        const col = colourOf(w, i);
        const list = buckets.get(col);

        if (list) list.push(i);
        else buckets.set(col, [i]);
      }

      const pulse = reduced ? 1 : 0.55 + 0.45 * Math.sin(now / 140);

      for (const [col, ids] of buckets) {
        ctx.fillStyle = col;
        ctx.globalAlpha = col === COLOURS.thinking ? pulse : 1;
        ctx.beginPath();

        for (const i of ids) {
          const p = position(w, i);

          ctx.rect(p.x - 2.2, p.y - 2.2, 4.4, 4.4);
        }

        ctx.fill();
      }

      ctx.globalAlpha = 1;

      // Rings where the rumour was just heard (the latest few hundred).
      const t = w.rumour;

      if (t && !reduced) {
        ctx.strokeStyle = COLOURS.believe;
        ctx.lineWidth = 1.2;

        let drawn = 0;

        for (let i = 0; i < t.status.length && drawn < 300; i++) {
          const age = w.time - t.heardAt[i];

          if (t.status[i] === Status.Unaware || age > 0.9) continue;

          const r = town.residents[i];

          ctx.globalAlpha = 1 - age / 0.9;
          ctx.beginPath();
          ctx.arc(r.x, r.y, 3 + age * 14, 0, Math.PI * 2);
          ctx.stroke();
          drawn++;
        }

        ctx.globalAlpha = 1;
      }

      paintPlaces(ctx, w.rumour?.message.place ?? null);

      if (selectedRef.current !== null) {
        const p = position(w, selectedRef.current);

        ctx.strokeStyle = "#17140f";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }

      frames++;

      if (now - frameClock > 1000) {
        setFps(Math.round((frames * 1000) / (now - frameClock)));
        frames = 0;
        frameClock = now;
      }

      if (now - lastPublish > 200) {
        lastPublish = now;
        setC(counts(w));

        if (settled(w)) setDone(true);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(raf);
  }, [town, stats.model]);

  const selectedRef = useRef<number | null>(null);

  selectedRef.current = selected;

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * VIEW.width;
    const y = ((e.clientY - rect.top) / rect.height) * VIEW.height;
    const w = worldRef.current;
    let best = -1;
    let bestD = 64;

    for (let i = 0; i < town.residents.length; i++) {
      const p = position(w, i);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;

      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }

    if (best >= 0) setSelected(best);
    else {
      const b = blockAt(town, x, y);

      if (b !== null) setBlock(b);
    }
  };

  const choosePreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);

    if (!p) return;

    setPresetId(id);
    setText(p.text);
    setCounterText(p.counter);
    setBlock(p.block);

    const m = model === "recorded" && id !== "scam" ? "free" : model;

    setModel(m);
    void start(p.text, p.block, m, p.place);
  };

  const pinIt = () => {
    const m = model === "recorded" && !recordedOk ? "free" : model;
    const place = isPreset && preset ? preset.place : placeIn(text);

    setModel(m);
    void start(text.trim().slice(0, 240), block, m, place);
  };

  const w = worldRef.current;
  const placeName = PLACES.find((p) => p.id === w.rumour?.message.place)?.name;
  const avgMs = stats.ms.length ? Math.round(stats.ms.reduce((a, b) => a + b, 0) / stats.ms.length) : null;
  const cost = stats.tokens * USD_PER_TOKEN;
  const profileCount = allProfiles("rumour").length;
  const verdict = w.rumour
    ? `In Bramble, ${c.heard.toLocaleString()} of ${town.residents.length.toLocaleString()} heard \u201c${w.rumour.message.text.replace(/[.!?]+$/, "")}\u201d. ${c.believe.toLocaleString()} believed it${placeName ? `, ${c.arrived.toLocaleString()} came to ${placeName}` : ""} and ${(c.argue + c.corrected).toLocaleString()} argued it down.`
    : "";
  const share = verdict ? `${verdict} Decided by ${MODEL_NAMES[stats.model]}. ${location.origin}/#experiment/rumour-mill` : "";

  const sel = selected !== null ? town.residents[selected] : null;
  const selTrack = w.rumour;
  const selDist = sel && selTrack ? selTrack.answers.get(keyFor(w, selTrack, sel.id)) : undefined;
  const selShared = sel && selTrack ? town.residents.filter((r) => selTrack.status[r.id] !== Status.Unaware && keyFor(w, selTrack, r.id) === keyFor(w, selTrack, sel.id)).length : 0;
  const teller = sel && selTrack && selTrack.from[sel.id] >= 0 ? town.residents[selTrack.from[sel.id]] : null;

  const saveMap = () => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return;

      const a = document.createElement("a");

      a.href = URL.createObjectURL(blob);
      a.download = "bramble-rumour.png";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  };

  return (
    <div className="toybox rm">
      <div className="rm-top">
        <div>
          <h2 className="rm-title">One rumour, 4,000 neighbours.</h2>
          <p className="rm-sub">
            Pin a rumour on a street in Bramble and watch it travel. Everyone who hears it decides once: ignore it, pass it
            on, go, or argue it down.
          </p>
        </div>
        <div className="rm-presets" role="group" aria-label="Rumours">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" aria-pressed={presetId === p.id && isPreset} onClick={() => choosePreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rm-grid">
        <div className="rm-stage rm-sticker">
          <canvas ref={canvasRef} className="rm-canvas" onClick={pick} aria-label="Map of Bramble. Dots are residents, coloured by what they did with the rumour. Click a dot to read their decision, or an empty block to pin the next rumour there." role="img" />
          <div className="rm-legend" aria-hidden="true">
            <span><i style={{ background: COLOURS.believe }} />believe</span>
            <span><i style={{ background: COLOURS.thinking }} />thinking</span>
            <span><i style={{ background: COLOURS.argue }} />argue it down</span>
            <span><i style={{ background: COLOURS.corrected }} />took the correction</span>
            <span><i style={{ background: COLOURS.ignore }} />ignored</span>
            <span><i style={{ background: COLOURS.unaware }} />not heard</span>
          </div>
        </div>

        <aside className="rm-side">
          <p className="rm-counter" aria-live="polite">
            <b>{c.heard.toLocaleString()}</b> heard it · <b>{c.believe.toLocaleString()}</b> believe
            {placeName && (
              <>
                {" "}
                · <b>{c.arrived.toLocaleString()}</b> came to {placeName}
              </>
            )}{" "}
            · <b>{(c.argue + c.corrected).toLocaleString()}</b> argued it down
            {c.thinking > 0 && <> · {c.thinking.toLocaleString()} thinking</>}
          </p>

          <div className="rm-model">
            <label htmlFor="rm-model">Who decides</label>
            <select id="rm-model" value={model} onChange={(e) => setModel(e.target.value as ModelId)}>
              <option value="free">{MODEL_NAMES.free}</option>
              <option value="jev">{MODEL_NAMES.jev}</option>
              <option value="recorded" disabled={!recordedOk}>
                {MODEL_NAMES.recorded}
                {recordedOk ? "" : " · the £500 scam only"}
              </option>
            </select>
            <p className="rm-stats">
              {stats.model === "free"
                ? `${profileCount} profiles scored ${stats.scoredIn === null ? "" : `in ${stats.scoredIn.toFixed(1)} ms `}· $0`
                : `${stats.calls} call${stats.calls === 1 ? "" : "s"}${avgMs === null ? "" : ` · ${avgMs} ms each`}${stats.model === "jev" ? ` · $${cost.toFixed(5)}` : " · $0.00111 when recorded"}`}
              {fps ? ` · ${fps} fps` : ""}
            </p>
            {model === "jev" && (
              <p className="rm-fine">
                About ${(profileCount * TOKENS_PER_PROFILE * USD_PER_TOKEN).toFixed(4)} per rumour and $
                {(allProfiles("counter").length * TOKENS_PER_PROFILE * USD_PER_TOKEN).toFixed(4)} per correction, on your key. Residents with
                the same profile share one answer, so a whole town takes a handful of calls, asked as people start hearing it.
              </p>
            )}
          </div>

          <form
            className="rm-write"
            onSubmit={(e) => {
              e.preventDefault();
              pinIt();
            }}
          >
            <label htmlFor="rm-text">Your rumour</label>
            <textarea id="rm-text" value={text} maxLength={240} rows={2} onChange={(e) => setText(e.target.value)} />
            <div className="rm-row">
              <button type="submit" className="rm-go" disabled={busy || !text.trim()}>
                Pin it on {town.blocks[block]?.street ?? "the street"}
              </button>
            </div>
            <p className="rm-fine">Click an empty block on the map to pin it somewhere else. Name a place (the bakery, the pub…) and people can go there.</p>
          </form>

          <form
            className="rm-write"
            onSubmit={(e) => {
              e.preventDefault();
              void correct();
            }}
          >
            <label htmlFor="rm-counter">The correction</label>
            <textarea id="rm-counter" value={counterText} maxLength={240} rows={2} onChange={(e) => setCounterText(e.target.value)} />
            <button type="submit" className="rm-counter-go" disabled={!w.rumour || busy || !counterText.trim()}>
              Pin the correction
            </button>
          </form>

          {note && (
            <p className="rm-note" role="status">
              {note}
            </p>
          )}

          {sel && selTrack && (
            <div className="rm-person rm-sticker">
              <b>
                {sel.name}
                {sel.hub ? `, ${sel.hub}` : ""}
              </b>
              <p className="rm-fine">
                {ARCHETYPES.find((a) => a.id === sel.archetype)?.label} · {sel.trust >= 0.5 ? "quick to trust" : "slow to trust"} ·{" "}
                {selTrack.status[sel.id] === Status.Unaware
                  ? "hasn't heard it"
                  : teller
                    ? `heard it from ${teller.name}`
                    : "read it on the noticeboard"}
              </p>
              {selTrack.status[sel.id] === Status.Decided && (
                <p>
                  <b>{{ ignore: "Ignored it", share: "Believed it and passed it on", go: `Went to ${placeName ?? "it"}`, argue: "Argued it down" }[selTrack.action[sel.id] ?? "ignore"]}</b>
                  {believes(w.counter, sel.id) ? ", then took the correction" : ""}
                </p>
              )}
              {selDist && (
                <div className="rm-bars">
                  {(["share", "go", "argue", "ignore"] as const)
                    .filter((k) => k !== "go" || w.rumour?.message.place)
                    .map((k) => (
                      <div key={k}>
                        <span>{{ share: "Pass it on", go: "Go", argue: "Argue", ignore: "Ignore" }[k]}</span>
                        <i style={{ width: `${Math.round(selDist[k] * 100)}%` }} />
                        <small>{Math.round(selDist[k] * 100)}%</small>
                      </div>
                    ))}
                </div>
              )}
              <p className="rm-fine">
                Odds from {MODEL_NAMES[stats.model]}, shared by {selShared.toLocaleString()} residents with the same profile; each drew their own
                action.
              </p>
            </div>
          )}

          {done && w.rumour && (
            <div className="rm-end rm-sticker">
              <b>
                {c.believe.toLocaleString()} of {town.residents.length.toLocaleString()} believed it.
              </b>
              <p>{verdict}</p>
              <div className="rm-row">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(share).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy the result"}
                </button>
                <button type="button" onClick={saveMap}>
                  Save the map
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {compare && (
        <section className="rm-compare rm-sticker">
          <div>
            <h3>The same scam, two deciders</h3>
            <p>
              On Jev's recorded answers, the £500 PIN scam reached {compare.jev.at(-1)?.heard.toLocaleString()} residents and{" "}
              {compare.jev.at(-1)?.believe.toLocaleString()} believed it. The free model buried it after {compare.free.at(-1)?.heard.toLocaleString()}.
              Jev played the characters: trusting pensioners told by a neighbour passed it on (90%); sceptics and teachers argued it down. The
              free model only saw that the text sounds like a scam.
            </p>
            <button type="button" onClick={() => { setModel("recorded"); choosePresetRecorded(); }}>
              Watch it on Jev (recorded)
            </button>
          </div>
          <Curve
            lines={[
              { name: "Jev", colour: COLOURS.believe, points: compare.jev },
              { name: "MiniLM", colour: COLOURS.argue, points: compare.free },
            ]}
          />
          <p className="rm-fine rm-curve-key">
            <span style={{ color: COLOURS.believe }}>■</span> Jev (recorded) <span style={{ color: COLOURS.argue }}>■</span> MiniLM (free)
          </p>
        </section>
      )}

      <details className="rm-how">
        <summary>How it works, and what it isn't</summary>
        <p>
          Bramble is a fictional town of 4,000 invented residents in twelve archetypes, linked to their nearest neighbours, a few people on the
          next street, and eight well-connected locals. It is not a model of real people.
        </p>
        <p>
          Residents with the same profile (archetype, quick or slow to trust, and who told them) share one answer: odds for ignore, pass it
          on, go, or argue. Each resident then draws their own action. That is {profileCount} profiles for a rumour and {allProfiles("counter").length} for a
          correction, which is why Jev can decide a whole town in a few calls.
        </p>
        <p>
          The free model is all-MiniLM-L6-v2, a 23 MB sentence-embedding model. It doesn't decide anything: it measures how close your text
          is to a few reference sentences (believable news, a scam, a joke, an invitation, a warning) and to each archetype, and a hand-set
          formula turns those into odds. The preset rumours were embedded ahead of time by the same model; your own text is embedded in your
          browser. Jev reads every profile as a typed choice and runs on your own gateway key.
        </p>
      </details>
    </div>
  );

  function choosePresetRecorded() {
    const p = PRESETS.find((x) => x.id === "scam");

    if (!p) return;

    setPresetId("scam");
    setText(p.text);
    setCounterText(p.counter);
    setBlock(p.block);
    void start(p.text, p.block, "recorded", p.place);
  }
}
