/**
 * Who said that? Real meeting audio from the AMI Meeting Corpus, sorted live into speakers,
 * conversations and topics by typed decisions you can inspect. Each line gets three decisions
 * (which speaker, which conversation, a new topic?), each option scored by named signals; code
 * keeps the running speakers, conversations and topics. The text questions behind three of the
 * signals come from free in-browser rules, from Jev's recorded answers, or from Jev live on the
 * visitor's key. Scored word by word against the corpus's own transcript.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_ON,
  countOdds,
  counts as countsOf,
  decide,
  hindsight,
  SIGNAL_LABELS,
  SIGNALS,
  type Decision,
  type Line,
  type Signal,
  type Weights,
} from "../../live-worlds/who-said-that/decide";
import { freeAnswers, fromJev, jevRequest, LOOKBACK, type TextAnswers } from "../../live-worlds/who-said-that/questions";
import { attribute, match, score, type Truth } from "../../live-worlds/who-said-that/score";
import type { Heard } from "../../live-worlds/who-said-that/signals";
import { markdown, renumber } from "../../live-worlds/who-said-that/transcript";
import { fetchJson, percent, run, useHasKey } from "./api";
import { formatCost, fromLiveBatches, fromRecorded, Receipt, type ReceiptData } from "./receipt";
import "./who-said-that.css";

type Scenario = { id: string; title: string; blurb: string; counts: Truth["counts"] };
type TruthDoc = Truth & {
  id: string;
  seconds: number;
  channels: number;
  source: { meeting: string; start: number; end: number; stream: string; conversation: string }[];
  licence: string;
};
type SignalsDoc = { recorded: string; models: Record<string, string>; ms: number; heard: Heard[] };
type JevReceipt = { latencyMs: number; inputTokens: number | null; costUsd: number | null; at: string; servedBy: string | null };
type Count = { value?: string; probabilities?: Record<string, number> | null };
type JevDoc = { model: string; answers: TextAnswers[]; receipts: JevReceipt[]; counts: { conversations: Count; topics: Count } | null };

type Lane = "free" | "jev" | "live";
type Source = "recorded" | "browser" | "mic";
type Work = { phase: "idle" } | { phase: "busy"; note: string } | { phase: "error"; message: string } | { phase: "consent" } | { phase: "recording"; seconds: number };

const SPEAKER_COLOURS = ["#ff6b4a", "#2f8cff", "#2bb673", "#f2b705", "#a259ff", "#ff4fa3", "#00b3b3", "#8a6d3b"];
const SIGNAL_COLOURS: Record<Signal, string> = {
  voice: "#2f8cff",
  level: "#8a6d3b",
  continues: "#ff6b4a",
  timing: "#00b3b3",
  topic: "#2bb673",
  reply: "#a259ff",
  membership: "#f2b705",
  shift: "#ff4fa3",
};
/** Where each signal comes from: the three text questions change with the lane. */
const SIGNAL_SOURCE: Record<Signal, string> = {
  voice: "CAM++ voice print",
  level: "audio level, or which phone",
  continues: "text question",
  timing: "audio timing",
  topic: "MiniLM meaning",
  reply: "text question",
  membership: "bookkeeping",
  shift: "text question",
};
const TEXT_SIGNALS = new Set<Signal>(["continues", "reply", "shift"]);
const SPEEDS = [1, 2, 4];
const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const speakerColour = (n: number) => SPEAKER_COLOURS[n % SPEAKER_COLOURS.length];
const convLetter = (n: number) => String.fromCharCode(65 + n);

/** Decode a file to 16 kHz floats, one array per channel. */
async function decode(buf: ArrayBuffer): Promise<Float32Array[]> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(buf);

  await ctx.close();

  const off = new OfflineAudioContext(decoded.numberOfChannels, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource();

  src.buffer = decoded;
  src.connect(off.destination);
  src.start();

  const out = await off.startRendering();

  return Array.from({ length: out.numberOfChannels }, (_, c) => out.getChannelData(c).slice());
}

/** Starts recording the microphone, locally. `stop` resolves to 16 kHz mono floats. */
async function startMic(): Promise<{ stop: () => Promise<Float32Array> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const chunks: Float32Array[] = [];
  // ScriptProcessor is deprecated but needs no worklet file; it only copies samples here.
  const proc = ctx.createScriptProcessor(4096, 1, 1);

  proc.onaudioprocess = (e) => chunks.push(e.inputBuffer.getChannelData(0).slice());
  source.connect(proc);
  proc.connect(ctx.destination);

  return {
    stop: async () => {
      proc.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());

      const rate = ctx.sampleRate;

      await ctx.close();

      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;

      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }

      const n = Math.floor((all.length * 16000) / rate);
      const out = new Float32Array(n);

      for (let i = 0; i < n; i++) out[i] = all[Math.floor((i * rate) / 16000)] ?? 0;

      return out;
    },
  };
}

/** Runs step one (words, voice prints, meaning) in a worker on this device. */
function listenInBrowser(channels: Float32Array[], onNote: (note: string) => void): Promise<{ heard: Heard[]; ms: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./who-said-that.worker.ts", import.meta.url), { type: "module" });

    w.onmessage = (e: MessageEvent) => {
      const m = e.data;

      if (m.type === "download") onNote(`Downloading the ${m.label} model (once) · ${m.percent}%`);
      else if (m.type === "ready") onNote("Listening…");
      else if (m.type === "segment") onNote(`Transcribing stretch ${m.done} of ${m.total}`);
      else if (m.type === "done") {
        w.terminate();
        resolve({ heard: m.heard, ms: m.ms });
      } else if (m.type === "error") {
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.postMessage({ channels }, channels.map((c) => c.buffer));
  });
}

/** One option of a decision: its probability and a diverging bar per signal that pushed it. */
function OptionRow({ label, p, push, chosen, colour }: { label: string; p: number; push: Partial<Record<Signal, number>>; chosen: boolean; colour?: string }) {
  const pushes = SIGNALS.filter((s) => push[s]);

  return (
    <li className={chosen ? "wst-opt wst-chosen" : "wst-opt"}>
      <span className="wst-opt-label">
        {colour && <i className="wst-dot" style={{ background: colour }} />}
        {label}
      </span>
      <span className="wst-opt-p">
        <span className="wst-pbar" style={{ width: percent(p) }} />
        <b>{percent(p)}</b>
      </span>
      <span className="wst-pushes">
        {pushes.length === 0 && <small>no signal yet: its score is its starting bias</small>}
        {pushes.map((s) => {
          const v = push[s]!;

          return (
            <span key={s} className="wst-push" title={`${SIGNAL_LABELS[s]}: ${v > 0 ? "+" : ""}${v.toFixed(2)}`}>
              <small>{SIGNAL_LABELS[s]}</small>
              <span className="wst-diverge">
                <span
                  className="wst-diverge-bar"
                  style={{ background: SIGNAL_COLOURS[s], width: `${Math.min(50, Math.abs(v) * 8)}%`, [v > 0 ? "left" : "right"]: "50%" }}
                />
              </span>
              <small className="wst-push-v">
                {v > 0 ? "+" : "−"}
                {Math.abs(v).toFixed(1)}
              </small>
            </span>
          );
        })}
      </span>
    </li>
  );
}

function DecisionBlock({ title, d, name, colourOf }: { title: string; d: Decision; name: (id: number) => string; colourOf?: (id: number) => string | undefined }) {
  const sorted = [...d.options].sort((a, b) => b.p - a.p);

  return (
    <section className="wst-decision">
      <h4>{title}</h4>
      <ol>
        {sorted.map((o) => (
          <OptionRow key={o.id} label={o.id < 0 ? o.label : name(o.id)} p={o.p} push={o.push} chosen={o.id < 0 ? !d.options.some((x) => x.id === d.chosen) : o.id === d.chosen} colour={o.id < 0 ? undefined : colourOf?.(o.id)} />
        ))}
      </ol>
    </section>
  );
}

function CountCard({ label, value, odds, truth, ended, jev, most }: { label: string; value: number; odds: Map<number, number>; truth?: number; ended: boolean; jev?: Count; most?: string }) {
  const rows = [...odds.entries()].sort((a, b) => a[0] - b[0]);

  return (
    <div className="wst-count">
      <span className="wst-count-label">{label}</span>
      <b className="wst-count-n">{value}</b>
      <ul aria-label={`How sure: ${label}`}>
        {rows.map(([n, p]) => (
          <li key={n} className={n === value ? "wst-on" : ""}>
            <span>{n}</span>
            <span className="wst-cbar">
              <span style={{ width: percent(p) }} />
            </span>
            <small>{percent(p)}</small>
          </li>
        ))}
      </ul>
      {truth !== undefined && <small className={ended ? "wst-truth wst-shown" : "wst-truth"}>{ended ? `Corpus: ${truth}` : "Corpus: at the end"}</small>}
      {jev?.value && (
        <small className="wst-jevcount">
          Jev asked once about the whole transcript: {COUNT_WORDS[jev.value] ?? jev.value}
          {jev.value === most ? " or more" : ""} ({percent(jev.probabilities?.[jev.value] ?? 0)})
        </small>
      )}
    </div>
  );
}

export function WhoSaidThat() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [sid, setSid] = useState("design-meeting");
  const [truth, setTruth] = useState<TruthDoc | null>(null);
  const [signals, setSignals] = useState<SignalsDoc | null>(null);
  const [jev, setJev] = useState<JevDoc | null>(null);
  const [heard, setHeard] = useState<Heard[]>([]);
  const [source, setSource] = useState<Source>("recorded");
  const [browserMs, setBrowserMs] = useState<number | null>(null);
  const [lane, setLane] = useState<Lane>("free");
  const [live, setLive] = useState<{ answers: TextAnswers[]; receipt: ReceiptData; for: Heard[] } | null>(null);
  const [liveNote, setLiveNote] = useState("");
  const [weights, setWeights] = useState<Weights>(ALL_ON);
  const [useHindsight, setUseHindsight] = useState(true);
  const [now, setNow] = useState(Infinity);
  const [speed, setSpeed] = useState(1);
  const [picked, setPicked] = useState<number | null>(null);
  const [work, setWork] = useState<Work>({ phase: "idle" });
  const [copied, setCopied] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const mic = useRef<{ stop: () => Promise<Float32Array> } | null>(null);
  const micTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const liveAbort = useRef<AbortController | null>(null);
  const hasKey = useHasKey();

  useEffect(() => {
    fetchJson<Scenario[]>("/who-said-that/scenarios.json").then(setScenarios, () => setWork({ phase: "error", message: "The scenarios could not be loaded." }));
  }, []);

  useEffect(() => {
    let alive = true;

    liveAbort.current?.abort();
    setTruth(null);
    setSignals(null);
    setJev(null);
    setHeard([]);
    setLive(null);
    setLiveNote("");
    setSource("recorded");
    setBrowserMs(null);
    setPicked(null);
    setNow(Infinity);
    setLane((l) => (l === "live" ? "free" : l));
    Promise.all([
      fetchJson<TruthDoc>(`/who-said-that/${sid}.truth.json`),
      fetchJson<SignalsDoc>(`/who-said-that/${sid}.signals.json`),
      fetchJson<JevDoc>(`/who-said-that/${sid}.jev.json`).catch(() => null),
    ]).then(
      ([t, s, j]) => {
        if (!alive) return;

        setTruth(t);
        setSignals(s);
        setJev(j);
        setHeard(s.heard);
      },
      () => alive && setWork({ phase: "error", message: "This scenario could not be loaded." }),
    );

    return () => {
      alive = false;
    };
  }, [sid]);

  useEffect(() => {
    const a = audio.current;

    if (a) a.playbackRate = speed;
  }, [speed, sid]);

  // A smooth playhead while the audio plays.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = audio.current;

      if (a && !a.paused && !a.ended) setNow(a.currentTime);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => () => liveAbort.current?.abort(), []);

  const recordedJev = source === "recorded" && jev ? jev : null;
  const effectiveLane: Lane = lane === "jev" && !recordedJev ? "free" : lane === "live" && (!live || live.for !== heard) ? "free" : lane;
  const text = useMemo<TextAnswers[]>(() => {
    if (effectiveLane === "jev" && recordedJev) return recordedJev.answers;

    if (effectiveLane === "live" && live) return live.answers;

    return freeAnswers(heard);
  }, [effectiveLane, recordedJev, live, heard]);

  const seconds = source === "mic" ? Math.max(1, ...heard.map((h) => h.end)) : (truth?.seconds ?? 90);
  const ended = now === Infinity;
  const until = ended ? heard.length : heard.filter((h) => h.end <= now).length;
  const state = useMemo(() => decide(heard, text, weights, until), [heard, text, weights, until]);
  const late = useMemo(() => hindsight(state, heard, weights), [state, heard, weights]);
  const labels = useMemo(
    () => state.lines.map((l, k) => (useHindsight ? { who: late[k].who, conv: late[k].conv, topic: l.topic } : { who: l.who, conv: l.conv, topic: l.topic })),
    [state, late, useHindsight],
  );
  const odds = useMemo(() => countOdds(heard, text, weights, until, 60), [heard, text, weights, until]);
  const counted = countsOf(state);
  const scored = truth && source !== "mic" ? score(truth, heard, labels, until) : null;
  const whoNo = useMemo(() => renumber(labels.map((l) => l.who)), [labels]);
  const convNo = useMemo(() => renumber(labels.map((l) => l.conv)), [labels]);
  const speakerName = (id: number) => `Speaker ${(whoNo.get(id) ?? id) + 1}`;
  const convName = (id: number) => `Conversation ${convLetter(convNo.get(id) ?? id)}`;
  const colourOf = (id: number) => (whoNo.has(id) ? speakerColour(whoNo.get(id)!) : undefined);
  const sel = picked !== null && picked < state.lines.length ? picked : state.lines.length - 1;
  const line: Line | undefined = state.lines[sel];

  // The corpus's answer, coloured by whichever predicted speaker it was matched to.
  const truthRuns = useMemo(() => {
    if (!truth || source === "mic") return [];

    const words = truth.words.filter((w) => ended || w.start <= now);
    const seg = attribute(words, heard.slice(0, until));
    const pred = seg.map((k) => (k >= 0 && labels[k] ? labels[k].who : -1));
    const m = match(pred, words.map((w) => w.speaker));
    const toPred = new Map([...m.entries()].map(([p, t]) => [t, p]));
    const runs: { conversation: string; speaker: string; start: number; end: number; pred?: number }[] = [];

    for (const w of words) {
      let last: (typeof runs)[number] | undefined;

      for (let k = runs.length - 1; k >= 0 && !last; k--) if (runs[k].conversation === w.conversation) last = runs[k];

      if (last && last.speaker === w.speaker && w.start - last.end < 0.6) last.end = Math.max(last.end, w.end);
      else runs.push({ conversation: w.conversation, speaker: w.speaker, start: w.start, end: w.end, pred: toPred.get(w.speaker) });
    }

    return runs;
  }, [truth, source, heard, labels, until, ended, now]);
  const trueConvs = [...new Set(truthRuns.map((r) => r.conversation))];
  const lanes = [...convNo.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);

  const play = (t?: number) => {
    const a = audio.current;

    if (!a) return;

    if (t !== undefined) a.currentTime = t;
    else if (ended || a.ended) a.currentTime = 0;

    setNow(a.currentTime);
    void a.play();
  };

  const runInBrowser = async () => {
    setWork({ phase: "busy", note: "Decoding the recording…" });

    try {
      const channels = await decode(await (await fetch(`/who-said-that/${sid}.mp3`)).arrayBuffer());
      const r = await listenInBrowser(channels, (note) => setWork({ phase: "busy", note }));

      setHeard(r.heard);
      setBrowserMs(r.ms);
      setSource("browser");
      setPicked(null);
      setWork({ phase: "idle" });
    } catch (e) {
      setWork({ phase: "error", message: e instanceof Error ? e.message : "The models could not run in this browser." });
    }
  };

  const startRecording = async () => {
    try {
      mic.current = await startMic();
      audio.current?.pause();

      const t0 = Date.now();
      const timer = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);

        if (s >= 60) void stopRecording();
        else setWork((w) => (w.phase === "recording" ? { phase: "recording", seconds: s } : w));
      }, 250);

      micTimer.current = timer;
      setWork({ phase: "recording", seconds: 0 });
    } catch (e) {
      setWork({ phase: "error", message: e instanceof Error ? e.message : "The microphone could not be used." });
    }
  };

  const stopRecording = async () => {
    const m = mic.current;

    if (!m) return;

    mic.current = null;
    clearInterval(micTimer.current);
    setWork({ phase: "busy", note: "Getting ready to listen…" });

    try {
      const r = await listenInBrowser([await m.stop()], (note) => setWork({ phase: "busy", note }));

      setHeard(r.heard);
      setBrowserMs(r.ms);
      setSource("mic");
      setPicked(null);
      setNow(Infinity);
      setLane((l) => (l === "jev" ? "free" : l));
      setWork(r.heard.length ? { phase: "idle" } : { phase: "error", message: "No speech was heard. Try again a little closer to the microphone." });
    } catch (e) {
      setWork({ phase: "error", message: e instanceof Error ? e.message : "The models could not run in this browser." });
    }
  };

  /** Jev answers the three text questions for every line, live on the visitor's key, four at a time. */
  const askJevLive = async () => {
    liveAbort.current?.abort();

    const abort = new AbortController();
    const target = heard;
    const bodies: unknown[] = new Array(target.length);
    const requests = target.map((_, i) => jevRequest(target, i));
    let next = 0;
    let done = 0;

    liveAbort.current = abort;
    setLiveNote(`Asking Jev about ${target.length} lines…`);

    const worker = async () => {
      while (next < target.length && !abort.signal.aborted) {
        const i = next++;

        bodies[i] = await run(requests[i].state, requests[i].questions, abort.signal, { deadlineMs: 15_000, maxAttempts: 2 });
        done++;
        setLiveNote(`Jev has answered ${done} of ${target.length} lines…`);
      }
    };

    try {
      await Promise.all([worker(), worker(), worker(), worker()]);

      if (abort.signal.aborted) return;

      const answers = bodies.map((b, i) => fromJev((b as { answers: Record<string, Count & { value?: unknown }> }).answers, Math.min(LOOKBACK, i)));

      setLive({ answers, receipt: fromLiveBatches(bodies, { note: "one request per line", first: requests[0] }), for: target });
      setLane("live");
      setLiveNote("");
    } catch (e) {
      if (abort.signal.aborted) return;

      abort.abort();
      setLiveNote(`${e instanceof Error ? e.message : "Jev could not be reached."} The free answers are still shown.`);
    }
  };

  const recordedCost = recordedJev ? recordedJev.receipts.reduce((s, r) => s + (r.costUsd ?? 0), 0) : null;
  const perLine = recordedJev && recordedCost !== null ? recordedCost / Math.max(1, recordedJev.receipts.length) : 0.00003;
  const lineAnswers = line ? text[line.i] : null;
  const replyTop = lineAnswers
    ? lineAnswers.replyTo.reduce((b, p, k) => (p > lineAnswers.replyTo[b] ? k : b), 0)
    : 0;
  const replyEarlier = line ? Math.min(LOOKBACK, line.i) : 0;
  const recordedReceipt =
    effectiveLane === "jev" && recordedJev && line ? fromRecorded(recordedJev.receipts[line.i], { questions: line.i === 0 ? 2 : 3, raw: { request: jevRequest(heard, line.i), response: recordedJev.answers[line.i] } }) : null;

  return (
    <div className="toybox wst">
      <p className="wst-lede">
        Real meetings, real voices. As the audio plays, three typed decisions sort every stretch of speech: who is speaking, which
        conversation it belongs to, and whether it starts a new topic. Code keeps count. Pick a line to see what pushed each
        decision, switch signals off, or let Jev answer the text questions.
      </p>

      <div className="wst-pills" role="group" aria-label="Scenario">
        {scenarios.map((s) => (
          <button key={s.id} type="button" aria-pressed={sid === s.id && source !== "mic"} onClick={() => {
              if (sid !== s.id) setSid(s.id);
              else if (signals && source !== "recorded") {
                setHeard(signals.heard);
                setSource("recorded");
                setPicked(null);
              }
            }}>
            {s.title}
          </button>
        ))}
        <button type="button" aria-pressed={source === "mic"} onClick={() => setWork({ phase: "consent" })}>
          Your own room
        </button>
      </div>
      {source !== "mic" && truth && <p className="wst-blurb">{scenarios.find((s) => s.id === sid)?.blurb}</p>}

      <div className="wst-player">
        {source !== "mic" && (
          <audio
            key={sid}
            ref={audio}
            controls
            preload="metadata"
            src={`/who-said-that/${sid}.mp3`}
            onPlay={(e) => {
              e.currentTarget.playbackRate = speed;
              setNow(e.currentTarget.currentTime);
            }}
            onSeeked={(e) => setNow(e.currentTarget.currentTime)}
            onEnded={() => setNow(Infinity)}
          />
        )}
        {source !== "mic" && (
          <>
            <button type="button" className="wst-play" onClick={() => play()}>
              {ended ? "Play from the start" : "Play"}
            </button>
            <span className="wst-speed" role="group" aria-label="Speed">
              {SPEEDS.map((s) => (
                <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </span>
            {!ended && (
              <button type="button" className="wst-link" onClick={() => {
                  audio.current?.pause();
                  setNow(Infinity);
                }}>
                Show the whole result
              </button>
            )}
          </>
        )}
      </div>

      {work.phase === "consent" && (
        <div className="wst-consent" role="dialog" aria-label="Use your microphone">
          <p>
            <b>Your microphone, on this device only.</b> Record up to a minute of the room you're in. Speech-to-text, voice prints and
            every decision run in this tab; nothing is uploaded unless you then ask Jev, which sends only the words. The models (about
            93 MB) download once.
          </p>
          <button type="button" onClick={() => void startRecording()}>
            Start recording
          </button>
          <button type="button" onClick={() => setWork({ phase: "idle" })}>
            Cancel
          </button>
        </div>
      )}
      {work.phase === "recording" && (
        <p className="wst-status" aria-live="polite">
          Recording · {work.seconds} s of 60{" "}
          <button type="button" onClick={() => void stopRecording()}>
            Stop and sort it
          </button>
        </p>
      )}
      {work.phase === "busy" && (
        <p className="wst-status" aria-live="polite">
          {work.note}
        </p>
      )}
      {work.phase === "error" && (
        <p className="wst-status wst-error" role="alert">
          {work.message}
        </p>
      )}

      <div className="wst-lanes" role="group" aria-label="Who answers the text questions">
        <span>Text questions answered by</span>
        <button type="button" aria-pressed={effectiveLane === "free"} onClick={() => setLane("free")}>
          Free rules <small>in your browser · $0</small>
        </button>
        <button type="button" aria-pressed={effectiveLane === "jev"} disabled={!recordedJev} onClick={() => setLane("jev")} title={recordedJev ? undefined : "Jev's recorded answers belong to the recorded segments"}>
          Jev, recorded <small>{recordedJev ? `${recordedJev.answers.length} lines · ${formatCost(recordedCost ?? 0)}` : "recorded segments only"}</small>
        </button>
        <button
          type="button"
          aria-pressed={effectiveLane === "live"}
          disabled={!hasKey || !heard.length || liveNote.startsWith("Asking") || liveNote.startsWith("Jev has")}
          onClick={() => (live && live.for === heard ? setLane("live") : void askJevLive())}
          title={hasKey ? undefined : "Connect your AI Gateway key in Settings"}
        >
          Jev, live <small>{hasKey ? `your key · about ${formatCost(perLine * heard.length)}` : "needs your key"}</small>
        </button>
      </div>
      {liveNote && (
        <p className="wst-status" role="status">
          {liveNote}
        </p>
      )}
      {effectiveLane === "live" && live && <Receipt data={live.receipt} label="Jev, live" />}

      {scored && (
        <p className="wst-accuracy" aria-live="off">
          <b>Against the corpus transcript, {ended ? "whole scenario" : "so far"}:</b> speaker {percent(scored.speaker.share)} · conversation {percent(scored.conversation.share)} · topic{" "}
          {percent(scored.topic.share)} of {scored.words} words{scored.missed ? ` (${scored.missed} never heard as speech, counted wrong)` : ""}
        </p>
      )}
      {source === "mic" && <p className="wst-accuracy">Your own room has no answer key, so there's no score.</p>}

      <div className="wst-stage">
        <section className="wst-timeline" aria-label="Timeline">
          <h3>
            Conversations as the decisions see them <small>{useHindsight ? "labels revised with hindsight" : "labels as first decided"}</small>
          </h3>
          {lanes.map((c) => (
            <div key={c} className="wst-lane">
              <span className="wst-lane-label">{convName(c)}</span>
              <div className="wst-track">
                {labels.map((l, k) =>
                  l.conv === c ? (
                    <button
                      key={`${k}-${l.who}-${l.conv}`}
                      type="button"
                      className={k === sel ? "wst-seg wst-sel" : "wst-seg"}
                      style={{
                        left: `${(heard[k].start / seconds) * 100}%`,
                        width: `${Math.max(0.4, ((heard[k].end - heard[k].start) / seconds) * 100)}%`,
                        background: colourOf(l.who),
                      }}
                      onClick={() => setPicked(k)}
                      aria-label={`${mmss(heard[k].start)} ${speakerName(l.who)}: ${heard[k].text}`}
                    />
                  ) : null,
                )}
                {!ended && <span className="wst-playhead" style={{ left: `${Math.min(100, (now / seconds) * 100)}%` }} />}
              </div>
            </div>
          ))}
          {!lanes.length && <p className="wst-empty">{ended ? "Nothing heard yet." : "Listening…"}</p>}
          {trueConvs.length > 0 && (
            <div className="wst-truthlanes">
              <h4>The corpus's answer (colour = the speaker it was matched to; grey = unmatched)</h4>
              {trueConvs.map((c) => (
                <div key={c} className="wst-lane wst-lane-truth">
                  <span className="wst-lane-label">{trueConvs.length > 1 ? c : "Transcript"}</span>
                  <div className="wst-track">
                    {truthRuns
                      .filter((r) => r.conversation === c)
                      .map((r, k) => (
                        <span
                          key={k}
                          className="wst-seg wst-truthseg"
                          title={r.speaker}
                          style={{
                            left: `${(r.start / seconds) * 100}%`,
                            width: `${Math.max(0.3, ((r.end - r.start) / seconds) * 100)}%`,
                            background: r.pred !== undefined ? colourOf(r.pred) : "#bbb",
                          }}
                        />
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="wst-axis">
            <span>0:00</span>
            <span>{mmss(seconds)}</span>
          </div>
        </section>

        <section className="wst-counts" aria-label="Running counts">
          <h3>Running counts</h3>
          <CountCard label="Speakers" value={counted.speakers} odds={odds.speakers} truth={source !== "mic" ? truth?.counts.speakers : undefined} ended={ended} />
          <CountCard label="Conversations" value={counted.conversations} odds={odds.conversations} truth={source !== "mic" ? truth?.counts.conversations : undefined} ended={ended} jev={effectiveLane === "jev" ? recordedJev?.counts?.conversations : undefined} most="three" />
          <CountCard label="Topics" value={counted.topics} odds={odds.topics} truth={source !== "mic" ? truth?.counts.topics : undefined} ended={ended} jev={effectiveLane === "jev" ? recordedJev?.counts?.topics : undefined} most="five" />
          <p className="wst-note">The bars re-run the same decisions 60 times, sampling each choice by its probability.</p>
        </section>
      </div>

      <div className="wst-stage wst-stage-2">
        <section className="wst-transcript" aria-label="Transcript">
          <h3>
            Transcript
            <button
              type="button"
              className="wst-link"
              onClick={() => {
                void navigator.clipboard?.writeText(markdown(heard.slice(0, until), labels));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy as Markdown"}
            </button>
          </h3>
          <div className="wst-columns" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(2, lanes.length))}, minmax(0, 1fr))` }}>
            {lanes.slice(0, 2).map((c) => (
              <ol key={c} aria-label={convName(c)}>
                {lanes.length > 1 && <li className="wst-colhead">{convName(c)}</li>}
                {labels.map((l, k) =>
                  l.conv === c ? (
                    <li key={`${k}-${l.who}-${l.conv}`} className={k === sel ? "wst-line wst-sel" : "wst-line"}>
                      <button type="button" onClick={() => setPicked(k)}>
                        <span className="wst-time">{mmss(heard[k].start)}</span>
                        <span className="wst-chip" style={{ background: colourOf(l.who) }}>
                          {speakerName(l.who)}
                        </span>
                        {state.lines[k].newTopic.yes && k > 0 && <span className="wst-newtopic">new topic</span>}
                        <span className="wst-text">{heard[k].text}</span>
                      </button>
                    </li>
                  ) : null,
                )}
              </ol>
            ))}
          </div>
          {lanes.length > 2 && <p className="wst-note">{lanes.length - 2} more conversation(s) are on the timeline.</p>}
        </section>

        <section className="wst-why" aria-label="Why">
          <h3>Why this line landed where it did</h3>
          {line && lineAnswers ? (
            <>
              <p className="wst-why-line">
                <span className="wst-time">{mmss(heard[line.i].start)}</span> “{heard[line.i].text}”
                {heard[line.i].channel !== undefined && (
                  <small>
                    {" "}
                    · loudest on phone {heard[line.i].channel! + 1}, by {heard[line.i].balance} dB
                  </small>
                )}
              </p>
              <p className="wst-answers">
                <b>{effectiveLane === "free" ? "Free rules" : "Jev"} answered:</b> continues the last line {percent(lineAnswers.continues)} · replies to{" "}
                {replyTop >= replyEarlier ? "none of the last lines" : `the line ${replyEarlier - replyTop} back`} ({percent(lineAnswers.replyTo[replyTop] ?? 0)}) · starts a new topic{" "}
                {percent(lineAnswers.newTopic)}
              </p>
              {recordedReceipt && <Receipt data={recordedReceipt} label="This line, recorded" />}
              <DecisionBlock title="Who is speaking?" d={line.speaker} name={speakerName} colourOf={colourOf} />
              <DecisionBlock title="Which conversation?" d={line.conversation} name={convName} />
              <section className="wst-decision">
                <h4>A new topic?</h4>
                <ol>
                  <OptionRow label={line.newTopic.yes ? "Yes" : "No, the same topic"} p={line.newTopic.yes ? line.newTopic.p : 1 - line.newTopic.p} push={line.newTopic.push} chosen />
                </ol>
              </section>
              {useHindsight && (late[sel].who !== line.who || late[sel].conv !== line.conv) && (
                <p className="wst-note">
                  These are the odds when the line arrived. With hindsight it now reads as {speakerName(late[sel].who)}, {convName(late[sel].conv)}.
                </p>
              )}
            </>
          ) : (
            <p className="wst-empty">Press play, or pick a line.</p>
          )}
        </section>
      </div>

      <fieldset className="wst-signals">
        <legend>Signals</legend>
        {SIGNALS.map((s) => (
          <label key={s}>
            <input type="checkbox" checked={weights[s] > 0} onChange={(e) => setWeights((w) => ({ ...w, [s]: e.target.checked ? 1 : 0 }))} />
            <i className="wst-dot" style={{ background: SIGNAL_COLOURS[s] }} />
            {SIGNAL_LABELS[s]} <small>{TEXT_SIGNALS.has(s) ? `${SIGNAL_SOURCE[s]} · ${effectiveLane === "free" ? "free rules" : "Jev"}` : SIGNAL_SOURCE[s]}</small>
          </label>
        ))}
        <label>
          <input type="checkbox" checked={useHindsight} onChange={(e) => setUseHindsight(e.target.checked)} /> Revise earlier labels with hindsight
        </label>
        <button type="button" className="wst-link" onClick={() => setWeights(ALL_ON)}>
          All on
        </button>
      </fieldset>

      <p className="wst-receipt-line">
        {source === "recorded" && signals && `Signals recorded ${signals.recorded} with ${Object.values(signals.models).join(", ")} · ${Math.round(signals.ms / 100) / 10} s of work`}
        {source === "browser" && browserMs !== null && `Heard again in your browser · ${Math.round(browserMs / 100) / 10} s · free`}
        {source === "mic" && browserMs !== null && `Your room, heard in your browser · ${Math.round(browserMs / 100) / 10} s · free`}
        {source !== "mic" && (
          <>
            {" · "}
            <button type="button" className="wst-link" disabled={work.phase === "busy"} onClick={() => void runInBrowser()}>
              Hear it again in your browser (free · ≈93 MB once)
            </button>
          </>
        )}
      </p>

    </div>
  );
}
