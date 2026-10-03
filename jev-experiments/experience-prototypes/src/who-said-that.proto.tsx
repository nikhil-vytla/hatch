/**
 * PROTOTYPE — "Who said that?": a better transcript from a noisy room. Tag two voices for a few
 * seconds each; every line then gets four typed questions (sounds like whom? same topic? continues
 * the last line? part of our conversation?) and lands with me, my friend, or the background.
 *
 * Three UI variants on one route, switched with ?v=a|b|c or the floating bar:
 *   a  transcript with speaker chips and the reasons behind each one
 *   b  timeline of segments in three lanes with their odds
 *   c  "fix my transcript": the raw transcript beside the fixed one
 *
 * Throwaway: lives on the proto/who-said-that branch, not main.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { redecide, type Answers, type Who } from "../../live-worlds/who-said-that/decide.proto";
import { getApiKey, run } from "./api";
import "./who-said-that.proto.css";

type Line = { start: number; end: number; text: string; answers: Answers };
type Recording = {
  clip: string;
  models: Record<string, string>;
  recordedAt: string;
  tags: { me: [number, number]; friend: [number, number] };
  summary: { segments: number; correct: number; accuracy: number; voiceOnlyAccuracy: number };
  expected: Who[];
  lines: Line[];
};

const CLIPS = {
  cafe: { label: "Café, floor plan", friend: "Priya", note: "the clip the rules were written against" },
  porto: { label: "Café, trip to Porto", friend: "Arjun", note: "held out: never used to set any rule" },
} as const;

type ClipId = keyof typeof CLIPS;
type Variant = "a" | "b" | "c";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function readVariant(): Variant {
  const v = new URLSearchParams(location.search).get("v");

  return v === "b" || v === "c" ? v : "a";
}

/** Decode any audio file to 16 kHz mono floats, in the browser. */
async function toMono16k(buf: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(buf);

  await ctx.close();

  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource();

  src.buffer = decoded;
  src.connect(off.destination);
  src.start();

  return (await off.startRendering()).getChannelData(0).slice();
}

/** Records the microphone for `seconds`, locally, and returns 16 kHz mono floats. */
async function recordMic(seconds: number, onTick: (left: number) => void): Promise<Float32Array> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const chunks: Float32Array[] = [];
  // ScriptProcessor is deprecated but needs no worklet file, which is fine for a prototype.
  const proc = ctx.createScriptProcessor(4096, 1, 1);

  proc.onaudioprocess = (e) => chunks.push(e.inputBuffer.getChannelData(0).slice());
  source.connect(proc);
  proc.connect(ctx.destination);

  for (let left = seconds; left > 0; left--) {
    onTick(left);
    await new Promise((r) => setTimeout(r, 1000));
  }

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
}

function Chip({ who, friend }: { who: Who; friend: string }) {
  return <span className={`wst-chip wst-${who}`}>{who === "me" ? "Me" : who === "friend" ? friend : "Background"}</span>;
}

function Odds({ a }: { a: Answers }) {
  const rows: [string, number][] = [
    ["sounds like me", a.voice.me],
    ["sounds like my friend", a.voice.friend],
    ["same topic as our chat", a.topic],
    ["continues the last line", a.continues],
    ["part of our conversation", a.conversation],
  ];

  return (
    <dl className="wst-odds">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            <span className="wst-bar" style={{ width: pct(v) }} />
            <b>{pct(v)}</b>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** a: the transcript, a chip per line, tap for the four answers. */
function TranscriptView({ lines, now, friend, expected }: { lines: Line[]; now: number; friend: string; expected?: Who[] }) {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <ol className="wst-transcript">
      {lines.map((l, i) =>
        l.start > now ? null : (
          <li key={i} className={l.answers.who === "else" ? "wst-faded" : ""}>
            <button type="button" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              <span className="wst-time">{mmss(l.start)}</span>
              <Chip who={l.answers.who} friend={friend} />
              <span className="wst-text">{l.text || "…"}</span>
              {expected && expected[i] !== l.answers.who && <span className="wst-miss" title="The script says otherwise">✗</span>}
            </button>
            {open === i && (
              <div className="wst-why">
                <Odds a={l.answers} />
                <p>{l.answers.reasons.join(" · ")}</p>
              </div>
            )}
          </li>
        ),
      )}
    </ol>
  );
}

/** b: three lanes on a time axis; block shade is how sure the decision was. */
function TimelineView({ lines, now, seconds, friend }: { lines: Line[]; now: number; seconds: number; friend: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const lanes: { who: Who; label: string }[] = [
    { who: "me", label: "Me" },
    { who: "friend", label: friend },
    { who: "else", label: "Background" },
  ];

  return (
    <div className="wst-timeline">
      {lanes.map((lane) => (
        <div key={lane.who} className="wst-lane">
          <span className="wst-lane-label">{lane.label}</span>
          <div className="wst-track">
            {lines.map((l, i) =>
              l.answers.who === lane.who ? (
                <button
                  key={i}
                  type="button"
                  className={`wst-block wst-${lane.who}`}
                  style={{ left: `${(l.start / seconds) * 100}%`, width: `${((l.end - l.start) / seconds) * 100}%`, opacity: 0.35 + 0.65 * Math.max(l.answers.conversation, 1 - l.answers.conversation) }}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onClick={() => setHover(i)}
                  aria-label={`${mmss(l.start)} ${l.text}`}
                />
              ) : null,
            )}
            <span className="wst-playhead" style={{ left: `${Math.min(100, (now / seconds) * 100)}%` }} />
          </div>
        </div>
      ))}
      <div className="wst-axis">
        <span>0:00</span>
        <span>{mmss(seconds)}</span>
      </div>
      {hover !== null && (
        <div className="wst-hover">
          <p>
            <Chip who={lines[hover].answers.who} friend={friend} /> {mmss(lines[hover].start)} · “{lines[hover].text}”
          </p>
          <Odds a={lines[hover].answers} />
        </div>
      )}
    </div>
  );
}

/** c: what a plain transcriber gives you, beside the fixed one. */
function FixView({ lines, friend }: { lines: Line[]; friend: string }) {
  const [showBackground, setShowBackground] = useState(false);
  const turns: { who: Who; start: number; text: string[] }[] = [];

  for (const l of lines) {
    if (!showBackground && l.answers.who === "else") continue;

    const last = turns.at(-1);

    if (last && last.who === l.answers.who) last.text.push(l.text);
    else turns.push({ who: l.answers.who, start: l.start, text: [l.text] });
  }

  return (
    <div className="wst-fix">
      <section>
        <h3>Before: one block of everything heard</h3>
        <p className="wst-raw">{lines.map((l) => l.text).join(" ")}</p>
      </section>
      <section>
        <h3>After: our conversation, by person</h3>
        <label className="wst-toggle">
          <input type="checkbox" checked={showBackground} onChange={(e) => setShowBackground(e.target.checked)} /> show background lines
        </label>
        {turns.map((t, i) => (
          <p key={i} className="wst-turn">
            <Chip who={t.who} friend={friend} /> <span className="wst-time">{mmss(t.start)}</span> {t.text.join(" ")}
          </p>
        ))}
        <button
          type="button"
          className="wst-copy"
          onClick={() =>
            void navigator.clipboard?.writeText(
              turns.map((t) => `${t.who === "me" ? "Me" : t.who === "friend" ? friend : "Background"} (${mmss(t.start)}): ${t.text.join(" ")}`).join("\n\n"),
            )
          }
        >
          Copy transcript
        </button>
      </section>
    </div>
  );
}

type LiveState =
  | { phase: "idle" }
  | { phase: "consent" }
  | { phase: "recording"; step: "me" | "friend" | "talk"; left: number }
  | { phase: "running"; note: string }
  | { phase: "error"; message: string };

export function WhoSaidThat() {
  const [variant, setVariant] = useState<Variant>(readVariant);
  const [clip, setClip] = useState<ClipId>("cafe");
  const [rec, setRec] = useState<Recording | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [source, setSource] = useState<"recorded" | "browser" | "mic" | "jev">("recorded");
  const [ms, setMs] = useState<Record<string, number> | null>(null);
  const [now, setNow] = useState(Infinity);
  const [live, setLive] = useState<LiveState>({ phase: "idle" });
  const [jevNote, setJevNote] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const micAudio = useRef<{ url: string; seconds: number } | null>(null);
  const friend = source === "mic" ? "Friend" : CLIPS[clip].friend;

  useEffect(() => {
    let alive = true;

    setRec(null);
    setSource("recorded");
    setMs(null);
    setJevNote("");
    fetch(`/who-said-that/${clip}.result.json`)
      .then((r) => r.json())
      .then((r: Recording) => {
        if (!alive) return;

        setRec(r);
        setLines(r.lines);
      });

    return () => {
      alive = false;
    };
  }, [clip]);

  const pickVariant = (v: Variant) => {
    setVariant(v);

    const u = new URL(location.href);

    u.searchParams.set("v", v);
    history.replaceState(null, "", u);
  };

  const seconds = useMemo(() => Math.max(1, ...lines.map((l) => l.end)) + 0.5, [lines]);
  // Each line's true speaker is the scripted line it overlaps most, so live runs whose segments
  // differ from the recording are still scored against the script, not against the recording.
  const [script, setScript] = useState<{ who: string; start: number; end: number }[] | null>(null);

  useEffect(() => {
    fetch(`/who-said-that/${clip}.truth.json`)
      .then((r) => r.json())
      .then((t: { lines: { who: string; start: number; end: number }[] }) => setScript(t.lines));
  }, [clip]);

  const expected = useMemo<Who[] | undefined>(() => {
    if (!script || source === "mic") return undefined;

    return lines.map((l) => {
      let best: { who: Who; overlap: number } = { who: "else", overlap: 0 };

      for (const t of script) {
        const ov = Math.min(l.end, t.end) - Math.max(l.start, t.start);

        if (ov > best.overlap) best = { who: t.who === "me" ? "me" : t.who === "priya" ? "friend" : "else", overlap: ov };
      }

      return best.who;
    });
  }, [lines, script, source]);

  const score = useMemo(() => {
    if (!expected) return null;

    return { right: lines.filter((l, i) => l.answers.who === expected[i]).length, total: lines.length };
  }, [lines, expected]);

  const runWorker = (audioData: Float32Array, tagged: Recording["tags"], kind: "browser" | "mic") =>
    new Promise<void>((resolve) => {
      const w = new Worker(new URL("./who-said-that.proto.worker.ts", import.meta.url), { type: "module" });

      w.onmessage = (e: MessageEvent) => {
        const m = e.data;

        if (m.type === "download") setLive({ phase: "running", note: `Downloading the ${m.label} model (once) · ${m.percent}%` });
        else if (m.type === "ready") setLive({ phase: "running", note: "Listening…" });
        else if (m.type === "segment") setLive({ phase: "running", note: `Transcribing line ${m.done} of ${m.total}` });
        else if (m.type === "done") {
          setLines(m.lines);
          setMs(m.ms);
          setSource(kind);
          setLive({ phase: "idle" });
          w.terminate();
          resolve();
        } else if (m.type === "error") {
          setLive({ phase: "error", message: m.message });
          w.terminate();
          resolve();
        }
      };
      w.postMessage({ audio: audioData, tagged }, [audioData.buffer]);
    });

  const runInBrowser = async () => {
    if (!rec) return;

    setLive({ phase: "running", note: "Decoding the clip…" });

    const buf = await (await fetch(`/who-said-that/${clip}.mp3`)).arrayBuffer();

    await runWorker(await toMono16k(buf), rec.tags, "browser");
  };

  const runMic = async () => {
    try {
      const tick = (step: "me" | "friend" | "talk") => (left: number) => setLive({ phase: "recording", step, left });
      const me = await recordMic(5, tick("me"));
      const fr = await recordMic(5, tick("friend"));
      const talk = await recordMic(30, tick("talk"));
      const all = new Float32Array(me.length + fr.length + talk.length);

      all.set(me);
      all.set(fr, me.length);
      all.set(talk, me.length + fr.length);
      micAudio.current = { url: "", seconds: all.length / 16000 };
      await runWorker(all, { me: [0, me.length / 16000], friend: [me.length / 16000, (me.length + fr.length) / 16000] }, "mic");
    } catch (e) {
      setLive({ phase: "error", message: e instanceof Error ? e.message : "The microphone could not be used." });
    }
  };

  /** Jev answers the two text questions for every line, in one request on the visitor's key. */
  const askJev = async () => {
    setJevNote("Asking Jev…");

    const questions: Record<string, unknown> = {};

    lines.forEach((l, i) => {
      const before = lines
        .slice(Math.max(0, i - 4), i)
        .filter((x) => x.answers.who !== "else")
        .map((x) => x.text)
        .join(" / ");

      questions[`topic_${i}`] = { type: "noul", instructions: `Conversation so far: "${before || "(none)"}". Is the new line "${l.text}" about the same subject as that conversation?` };
      questions[`continues_${i}`] = { type: "noul", instructions: `Previous line: "${lines[i - 1]?.text ?? "(none)"}". Does the new line "${l.text}" carry on the previous line's sentence or thought?` };
    });

    try {
      const t0 = performance.now();
      const r = (await run({ setting: "Two friends talking in a noisy café; other people nearby." }, questions)) as {
        answers: Record<string, { value?: number }>;
        usage?: { input_tokens?: number };
      };
      const text = lines.map((_, i) => ({ topic: r.answers[`topic_${i}`]?.value, continues: r.answers[`continues_${i}`]?.value }));

      setLines((ls) => redecide(ls.map((l) => l.answers), text).map((a, i) => ({ ...ls[i], answers: a })));
      setSource("jev");

      const cost = ((r.usage?.input_tokens ?? 0) * 0.042) / 1e6;

      setJevNote(`Jev answered ${lines.length * 2} questions in one call · ${Math.round(performance.now() - t0)} ms · $${cost.toFixed(6)} · live · your key`);
    } catch (e) {
      setJevNote(e instanceof Error ? e.message : "Jev could not be reached.");
    }
  };

  return (
    <div className="toybox wst">
      <p className="wst-lede">
        Two friends talk in a busy café. Tag each voice for a few seconds; every line then gets four quick questions and lands with
        the right person, or with the background.
      </p>

      <div className="wst-controls">
        <div role="group" aria-label="Recording">
          {(Object.keys(CLIPS) as ClipId[]).map((c) => (
            <button key={c} type="button" aria-pressed={clip === c && source !== "mic"} onClick={() => setClip(c)}>
              {CLIPS[c].label}
              <small>recorded · free</small>
            </button>
          ))}
          <button type="button" aria-pressed={source === "mic"} onClick={() => setLive({ phase: "consent" })}>
            Your own conversation
            <small>your mic · stays on this device</small>
          </button>
        </div>
        {source !== "mic" && (
          <audio
            ref={audio}
            controls
            src={`/who-said-that/${clip}.mp3`}
            onPlay={() => setNow(audio.current?.currentTime ?? 0)}
            onTimeUpdate={() => setNow(audio.current?.currentTime ?? Infinity)}
            onEnded={() => setNow(Infinity)}
          />
        )}
      </div>

      {live.phase === "consent" && (
        <div className="wst-consent" role="dialog" aria-label="Use your microphone">
          <p>
            <b>Your microphone, on this device only.</b> We record 5 seconds of you, 5 seconds of your friend, then 30 seconds of you
            talking. Speech-to-text, voice fingerprints and the decisions all run in this tab; nothing is uploaded. The models (about
            93 MB) download once.
          </p>
          <button type="button" onClick={() => void runMic()}>
            Start
          </button>
          <button type="button" onClick={() => setLive({ phase: "idle" })}>
            Cancel
          </button>
        </div>
      )}
      {live.phase === "recording" && (
        <p className="wst-status" aria-live="polite">
          {live.step === "me" ? "Say anything: this is you" : live.step === "friend" ? "Now your friend" : "Now talk together"} · {live.left} s
        </p>
      )}
      {live.phase === "running" && (
        <p className="wst-status" aria-live="polite">
          {live.note}
        </p>
      )}
      {live.phase === "error" && (
        <p className="wst-status wst-error" role="alert">
          {live.message}
        </p>
      )}

      {rec && (
        <div className="wst-receipt">
          {score && (
            <span>
              <b>
                {score.right} of {score.total} lines right
              </b>{" "}
              against the script ({CLIPS[clip].note})
            </span>
          )}
          <span>
            {source === "recorded"
              ? `recorded ${rec.recordedAt.slice(0, 10)} · free`
              : source === "browser"
                ? "in your browser · free"
                : source === "mic"
                  ? "your mic · in your browser · free"
                  : "text questions answered by Jev · your key"}
          </span>
          {ms && <span>{Math.round(ms.asr + ms.voice + ms.embed + ms.decide)} ms of work for {lines.length} lines</span>}
          <span className="wst-actions">
            {source !== "mic" && (
              <button type="button" onClick={() => void runInBrowser()} disabled={live.phase === "running"}>
                Run it in your browser <small>free · ≈93 MB once</small>
              </button>
            )}
            <button type="button" onClick={() => void askJev()} disabled={!getApiKey() || !lines.length}>
              Ask Jev the text questions <small>{getApiKey() ? "live · your key" : "live · needs your key"}</small>
            </button>
          </span>
          {jevNote && <span>{jevNote}</span>}
        </div>
      )}

      {lines.length > 0 &&
        (variant === "a" ? (
          <TranscriptView lines={lines} now={now} friend={friend} expected={expected} />
        ) : variant === "b" ? (
          <TimelineView lines={lines} now={now === Infinity ? seconds : now} seconds={seconds} friend={friend} />
        ) : (
          <FixView lines={lines} friend={friend} />
        ))}

      <details className="wst-how">
        <summary>How it decides, and what it can't do</summary>
        <p>
          Speech is found by loudness against the room's noise floor, then each stretch is transcribed by whisper-tiny.en and
          fingerprinted by Wespeaker's CAM++ voice model. Four typed questions follow: <i>sounds like whom?</i> (voice similarity to
          the two tags), <i>same topic?</i> (sentence similarity to the last few lines of our conversation, by all-MiniLM-L6-v2),{" "}
          <i>continues the last line?</i> (a repeated word, a sentence left hanging on “and”, a line that starts within a breath), and{" "}
          <i>part of our conversation?</i> (the three combined). The rules are hand-set; nothing was trained, and no Jev output is used.
          With your own key, Jev can answer the two text questions instead.
        </p>
        <p>
          On the held-out clip the full pipeline got {rec?.clip === "porto" ? `${rec.summary.correct} of ${rec.summary.segments}` : "13 of 15"} lines right, against
          80% from the voice alone. On the clip the rules were written against it got 24 of 26, slightly <i>below</i> voice alone (96%).
          Both clips use synthetic voices (Kokoro TTS) over synthetic café babble, which is easier than a real room: real overlapping
          speech, one speaker splitting into two segments, and similar-sounding friends will all do worse.
        </p>
      </details>

      <nav className="wst-variants" aria-label="Prototype variants">
        <span>Prototype view</span>
        {(["a", "b", "c"] as Variant[]).map((v) => (
          <button key={v} type="button" aria-pressed={variant === v} onClick={() => pickVariant(v)}>
            {v === "a" ? "A · transcript" : v === "b" ? "B · timeline" : "C · fix my transcript"}
          </button>
        ))}
      </nav>
    </div>
  );
}
