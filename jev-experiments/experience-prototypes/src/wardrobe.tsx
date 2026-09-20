import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  CircleStop,
  Glasses,
  Mic,
  Play,
  RotateCcw,
  Shirt,
  Sparkles,
  Undo2,
  Volume2,
  X,
} from "lucide-react";
import { getApiKey, run } from "./api";
import {
  CATALOG,
  COLORS,
  DEMO_COMMANDS,
  FAL_MODEL,
  INITIAL_OUTFIT,
  SESSION_SECONDS,
  applyPatch,
  currentTicket,
  editQuestions,
  editState,
  fullPrompt,
  garmentImage,
  interpretEdit,
  item,
  type Color,
  type Outfit,
  type Patch,
  type Provenance,
} from "../../wardrobe-lab/engine";
import { drawPresenter, referenceData } from "../../wardrobe-lab/illustration";
import {
  connectWardrobe,
  type VideoEvent,
  type VideoSession,
} from "../server/wardrobe-stream";
import "./wardrobe.css";
type Turn = {
  id: number;
  text: string;
  source: string;
  provenance: string;
  before: Outfit;
  after: Outfit;
  raw?: any;
  reason?: string;
};
const sourceLabel = {
  manual: "Your choice",
  "recorded-jev": "Recorded Jev",
  "live-jev": "Live Jev",
};
export function Wardrobe({ result }: { result: any }) {
  const reduced = useReducedMotion(),
    [outfit, setOutfit] = useState<Outfit>(INITIAL_OUTFIT),
    outfitRef = useRef(INITIAL_OUTFIT),
    [history, setHistory] = useState<Outfit[]>([]),
    historyRef = useRef<Outfit[]>([]),
    [turns, setTurns] = useState<Turn[]>([]);
  const [transcriptSource, setTranscriptSource] = useState("typed"),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(
      "Start with a jacket. Then add a little attitude.",
    ),
    [source, setSource] = useState<Provenance>("manual"),
    [mode, setMode] = useState<"recorded" | "live">("recorded"),
    [demoStep, setDemoStep] = useState(0),
    [slot, setSlot] = useState<"jacket" | "glasses">("jacket"),
    [inspect, setInspect] = useState(false),
    [speak, setSpeak] = useState(false),
    [listening, setListening] = useState(false);
  const ticket = useRef({ session: 0, revision: 0 }),
    request = useRef<AbortController | null>(null),
    recognition = useRef<any>(null),
    speaking = useRef(false),
    mounted = useRef(true);
  const [showConnect, setShowConnect] = useState(false),
    [falKey, setFalKey] = useState(""),
    [inputSource, setInputSource] = useState<"illustration" | "camera">(
      "illustration",
    ),
    [consent, setConsent] = useState(false),
    [videoStatus, setVideoStatus] = useState<"off" | "connecting" | "live">(
      "off",
    ),
    [events, setEvents] = useState<VideoEvent[]>([]),
    [videoError, setVideoError] = useState(""),
    [seconds, setSeconds] = useState(0),
    [preview, setPreview] = useState(false),
    [recording, setRecording] = useState<any>(null),
    [pipeline, setPipeline] = useState<any>(null);
  const avatar = useRef<HTMLCanvasElement>(null),
    synthetic = useRef<HTMLCanvasElement>(null),
    remoteVideo = useRef<HTMLVideoElement>(null),
    videoSession = useRef<VideoSession | null>(null),
    media = useRef<MediaStream | null>(null),
    videoEpoch = useRef(0),
    videoClock = useRef<ReturnType<typeof setInterval> | null>(null),
    playback = useRef<HTMLVideoElement>(null);
  const rows: any[] = result?.rows ?? [],
    demoRows = DEMO_COMMANDS.map((c) => rows.find((r) => r.id === c.id));
  const invalidate = () => {
    ticket.current = {
      ...ticket.current,
      revision: ticket.current.revision + 1,
    };
    request.current?.abort();
    request.current = null;
    setBusy(false);
  };
  const say = (value: string) => {
    setMessage(value);
    if (speaking.current && "speechSynthesis" in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(value);
      u.rate = 1;
      speechSynthesis.speak(u);
    }
  };
  const disconnect = (forget = true) => {
    videoEpoch.current++;
    videoSession.current?.close();
    videoSession.current = null;
    media.current?.getTracks().forEach((t) => t.stop());
    media.current = null;
    if (remoteVideo.current) remoteVideo.current.srcObject = null;
    if (videoClock.current) clearInterval(videoClock.current);
    videoClock.current = null;
    if (mounted.current) {
      setVideoStatus("off");
      if (forget) setFalKey("");
    }
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const read = (name: string) =>
      fetch(`/wardrobe/${name}`, { signal: controller.signal })
        .then((r) =>
          r.ok && r.headers.get("content-type")?.includes("application/json")
            ? r.json()
            : null,
        )
        .catch(() => null);
    void Promise.all([
      read("spoken-recording.json"),
      read("recording.json"),
      read("spoken-pipeline.json"),
    ]).then(([spoken, control, evidence]) => {
      if (!mounted.current) return;
      setRecording(
        spoken?.status === "complete" ? { ...spoken, spoken: true } : control,
      );
      setPipeline(evidence);
    });
    const hidden = () => {
      if (document.hidden) disconnect();
    };
    const leave = () => disconnect();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      mounted.current = false;
      controller.abort();
      request.current?.abort();
      ticket.current.session++;
      recognition.current?.abort();
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      disconnect();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
    };
  }, []);
  useEffect(() => {
    speaking.current = speak;
    if (!speak && "speechSynthesis" in window) speechSynthesis.cancel();
  }, [speak]);
  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const draw = () => {
      if (avatar.current)
        drawPresenter(
          avatar.current,
          outfitRef.current,
          reduced ? 0 : (performance.now() - start) / 1000,
        );
      if (synthetic.current)
        drawPresenter(
          synthetic.current,
          INITIAL_OUTFIT,
          reduced ? 0 : (performance.now() - start) / 1000,
        );
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [reduced]);
  const commit = (
    next: Outfit,
    command: string,
    provenance: Provenance,
    commandSource: string,
    raw?: any,
    reason?: string,
  ) => {
    const before = outfitRef.current;
    invalidate();
    historyRef.current = [...historyRef.current, before];
    setHistory(historyRef.current);
    outfitRef.current = next;
    setOutfit(next);
    setSource(provenance);
    setTurns((t) => [
      ...t,
      {
        id: ticket.current.revision,
        text: command,
        source: commandSource,
        provenance,
        before,
        after: next,
        raw,
        reason,
      },
    ]);
    videoSession.current?.update({
      prompt: fullPrompt(next),
      reference: referenceData(next),
      revision: ticket.current.revision,
    });
    say(reason ?? "Done. Everything else stays with you.");
  };
  const manual = (patch: Patch, label: string) => {
    try {
      commit(applyPatch(outfitRef.current, patch), label, "manual", "catalog");
    } catch (e) {
      say(e instanceof Error ? e.message : "This combination is unavailable.");
    }
  };
  const undo = () => {
    invalidate();
    const previous = historyRef.current.at(-1);
    if (!previous) {
      say("Nothing to undo yet.");
      return;
    }
    historyRef.current = historyRef.current.slice(0, -1);
    setHistory(historyRef.current);
    outfitRef.current = previous;
    setOutfit(previous);
    setSource("manual");
    videoSession.current?.update({
      prompt: fullPrompt(previous),
      reference: referenceData(previous),
      revision: ticket.current.revision,
    });
    setTurns((t) => [
      ...t,
      {
        id: ticket.current.revision,
        text: "Undo last change",
        source: "control",
        provenance: "manual",
        before: outfit,
        after: previous,
      },
    ]);
    say("Back one change.");
    setDemoStep(0);
  };
  const reset = () => {
    invalidate();
    ticket.current.session++;
    outfitRef.current = INITIAL_OUTFIT;
    setOutfit(INITIAL_OUTFIT);
    historyRef.current = [];
    setHistory([]);
    setTurns([]);
    setDemoStep(0);
    setSource("manual");
    videoSession.current?.update({
      prompt: fullPrompt(INITIAL_OUTFIT),
      reference: referenceData(INITIAL_OUTFIT),
      revision: ticket.current.revision,
    });
    say("A fresh outfit. What comes first?");
  };
  const accept = (
    response: any,
    command: string,
    provenance: Provenance,
    commandSource: string,
  ) => {
    const decision = interpretEdit(outfitRef.current, response, command);
    if (decision.action === "apply")
      commit(
        decision.outfit,
        command,
        provenance,
        commandSource,
        response,
        decision.reason || undefined,
      );
    else if (decision.action === "undo") undo();
    else if (decision.action === "reset") reset();
    else {
      setTurns((t) => [
        ...t,
        {
          id: ticket.current.revision,
          text: command,
          source: commandSource,
          provenance,
          before: outfitRef.current,
          after: outfitRef.current,
          raw: response,
          reason: decision.reason,
        },
      ]);
      say(decision.reason);
    }
  };
  const submit = async (command = text, commandSource = transcriptSource) => {
    if (!command.trim()) return;
    if (!getApiKey()) {
      say(
        "Connect your Jev key in Live mode above to interpret a new command. You can still use the wardrobe controls.",
      );
      return;
    }
    invalidate();
    const controller = new AbortController();
    request.current = controller;
    const sent = { ...ticket.current };
    setBusy(true);
    setText(command);
    try {
      const response = await run(
        editState(outfitRef.current, command),
        editQuestions(outfitRef.current),
        controller.signal,
      );
      if (!mounted.current || !currentTicket(sent, ticket.current)) return;
      accept(response, command, "live-jev", commandSource);
      setText("");
    } catch (e) {
      if (!controller.signal.aborted && mounted.current)
        say(
          e instanceof Error
            ? e.message
            : "Jev could not interpret that change.",
        );
    } finally {
      if (currentTicket(sent, ticket.current)) setBusy(false);
    }
  };
  const replay = () => {
    const index = demoStep >= DEMO_COMMANDS.length ? 0 : demoStep,
      row = demoRows[index];
    if (!row?.response) {
      say(
        "This recorded decision is unavailable. Choose an item below or connect Jev.",
      );
      return;
    }
    if (JSON.stringify(outfitRef.current) !== JSON.stringify(row.before)) {
      if (index === 0) {
        reset();
      } else {
        say(
          "This recorded case starts from a different outfit. Start over to replay the recorded sequence; your current outfit is preserved.",
        );
        return;
      }
    }
    accept(
      row.response,
      row.text,
      "recorded-jev",
      "authored demonstration text",
    );
    setDemoStep(index + 1);
  };
  const listen = () => {
    const Speech =
      (window as any).SpeechRecognition ??
      (window as any).webkitSpeechRecognition;
    if (!Speech) {
      say(
        "Speech recognition is not supported in this browser. Type the same command below.",
      );
      return;
    }
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const r = new Speech();
    recognition.current = r;
    r.lang = "en-US";
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setText(transcript);
      setTranscriptSource("speech");
      say("Transcript ready. Review it, then send it to Jev.");
    };
    r.onerror = () => {
      setListening(false);
      say("Speech recognition stopped. You can type your command instead.");
    };
    r.onend = () => setListening(false);
    r.start();
    setListening(true);
  };
  const connect = async () => {
    if (!falKey.trim() || !consent) return;
    disconnect(false);
    const epoch = videoEpoch.current;
    setVideoStatus("connecting");
    setVideoError("");
    setEvents([]);
    setSeconds(0);
    setPreview(false);
    playback.current?.pause();
    try {
      const stream =
        inputSource === "camera"
          ? await navigator.mediaDevices.getUserMedia({
              video: { width: 512, height: 768 },
              audio: false,
            })
          : synthetic.current!.captureStream(20);
      if (epoch !== videoEpoch.current || !mounted.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      media.current = stream;
      const started = Date.now();
      videoClock.current = setInterval(
        () => setSeconds(Math.floor((Date.now() - started) / 1000)),
        1000,
      );
      const session = connectWardrobe({
        input: stream,
        initial: {
          prompt: fullPrompt(outfitRef.current),
          reference: referenceData(outfitRef.current),
          revision: ticket.current.revision,
        },
        token: async (signal) => {
          const response = await fetch("/api/wardrobe-token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${falKey.trim()}`,
            },
            body: JSON.stringify({ model: FAL_MODEL }),
            signal,
          });
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error ?? "Video authorization failed.");
          return data.token;
        },
        onStream: (stream) => {
          if (epoch !== videoEpoch.current) return;
          if (remoteVideo.current) {
            remoteVideo.current.srcObject = stream;
            void remoteVideo.current.play().catch(() => {});
          }
          setVideoStatus("live");
        },
        onEvent: (event) => {
          if (epoch !== videoEpoch.current || !mounted.current) return;
          setEvents((old) => [...old.slice(-19), event]);
          if (event.type === "disconnected") {
            setVideoStatus("off");
            setFalKey("");
            if (videoClock.current) clearInterval(videoClock.current);
            media.current = null;
            videoSession.current = null;
          }
        },
        onError: (error) => {
          if (epoch === videoEpoch.current && mounted.current)
            setVideoError(error);
        },
      });
      videoSession.current = session;
      setShowConnect(false);
      await session.ready;
    } catch (e) {
      if (epoch === videoEpoch.current) {
        disconnect();
        setVideoError(
          e instanceof Error
            ? e.message
            : "Camera or video connection unavailable.",
        );
      }
    }
  };
  const selected = slot === "jacket" ? outfit.jacket : outfit.glasses,
    color = slot === "jacket" ? outfit.jacketColor : outfit.glassesColor,
    selectedItem = item(selected),
    demo = DEMO_COMMANDS[demoStep % DEMO_COMMANDS.length];
  const label =
    videoStatus === "live"
      ? "Live Lucy 2.1 video"
      : preview
        ? recording?.spoken
          ? "Lucy 2.1 · spoken Jev replay"
          : "Lucy 2.1 · authored outfit steps"
        : "Code avatar · not AI video";
  return (
    <div className="wardrobe-lab">
      <header className="wardrobe-header">
        <div>
          <span className="wardrobe-eyebrow">THE FITTING ROOM · 01</span>
          <h2>
            Change your mind.
            <br />
            <em>Keep your look.</em>
          </h2>
          <p>
            A jacket. Some shades. “Make them pink.”
            <br />
            Small words, one outfit that remembers.
          </p>
        </div>
        <div className="wardrobe-intro-tag">
          <Shirt size={24} />
          <span>
            7 pieces.
            <br />
            Room to play.
          </span>
        </div>
      </header>
      {preview && (
        <p className="wardrobe-playback-note">
          {recording?.spoken
            ? "Recorded synthetic speech → local Whisper → genuine Jev decisions → Lucy video. Accepted states replay on a fixed schedule; original stage timings are below."
            : "Provider video from authored outfit steps. This control clip was not driven by Jev."}
        </p>
      )}
      <div className="wardrobe-layout">
        <section className="wardrobe-stage" aria-label="Outfit preview">
          <div className="wardrobe-stage-top">
            <span className={videoStatus === "live" ? "wardrobe-live-dot" : ""}>
              {label}
            </span>
            <span>
              {videoStatus === "off"
                ? "LOOK " + String(history.length + 1).padStart(2, "0")
                : `${seconds}s / ${SESSION_SECONDS}s`}
            </span>
          </div>
          <canvas
            ref={avatar}
            width={512}
            height={768}
            role="img"
            aria-label={`Illustrated outfit: ${outfit.jacket === "none" ? "no jacket" : outfit.jacketColor + " " + outfit.jacket + " jacket"}, ${outfit.glasses === "none" ? "no sunglasses" : outfit.glassesColor + " " + outfit.glassesSize + " " + outfit.glasses + " sunglasses"}`}
            className={
              videoStatus === "live" || preview
                ? "wardrobe-avatar hidden"
                : "wardrobe-avatar"
            }
          />
          <canvas
            ref={synthetic}
            width={512}
            height={768}
            className="wardrobe-source"
            aria-hidden="true"
          />
          <video
            ref={remoteVideo}
            className={`wardrobe-output ${videoStatus === "live" ? "" : "hidden"}`}
            muted
            autoPlay
            playsInline
            aria-label="Live generated try-on video"
          />
          {recording?.status === "complete" && (
            <video
              ref={playback}
              className={`wardrobe-output ${preview ? "" : "hidden"}`}
              src={
                recording?.spoken
                  ? "/wardrobe/spoken-try-on-demo.webm"
                  : "/wardrobe/try-on-demo.webm"
              }
              controls
              playsInline
              onEnded={() => setPreview(false)}
              aria-label="30-second recorded Lucy try-on demonstration"
            />
          )}
          {!preview && (
            <div className="wardrobe-stage-caption">
              <AnimatePresence mode="wait">
                <motion.div
                  key={outfit.jacket + "-" + outfit.glasses + "-" + color}
                  initial={reduced ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? {} : { opacity: 0 }}
                >
                  <span>
                    {outfit.jacket === "none"
                      ? "The starting point"
                      : `${outfit.jacketColor} ${item(outfit.jacket)?.type}`}
                  </span>
                  <strong>
                    {outfit.glasses === "none"
                      ? outfit.jacket === "none"
                        ? "Ready for a first layer."
                        : "One layer. Your move."
                      : `${outfit.glassesColor} ${outfit.glassesSize === "large" ? "oversized " : ""}${item(outfit.glasses)?.type}`}
                  </strong>
                </motion.div>
              </AnimatePresence>
            </div>
          )}
          <div className="wardrobe-stage-actions">
            {videoStatus === "off" ? (
              <button
                onClick={() => {
                  setShowConnect(!showConnect);
                  setConsent(false);
                }}
              >
                <Camera size={15} />
                Connect live video
              </button>
            ) : (
              <button onClick={() => disconnect()}>
                <CircleStop size={15} />
                Disconnect & forget key
              </button>
            )}
            {recording?.status === "complete" && videoStatus === "off" && (
              <button
                onClick={() => {
                  setPreview(!preview);
                  if (preview) playback.current?.pause();
                  else void playback.current?.play();
                }}
              >
                <Play size={14} />
                {preview
                  ? "Close recording"
                  : recording?.spoken
                    ? "30s spoken demo"
                    : "30s real recording"}
              </button>
            )}
          </div>
        </section>
        <section className="wardrobe-workbench" aria-label="Outfit controls">
          <div className="wardrobe-command-top">
            <span className="wardrobe-eyebrow">SAY IT. SEE WHAT CHANGES.</span>
            <span className="wardrobe-provenance">{sourceLabel[source]}</span>
          </div>
          <div
            className="wardrobe-mode"
            role="group"
            aria-label="Decision source"
          >
            <button
              aria-pressed={mode === "recorded"}
              onClick={() => setMode("recorded")}
            >
              Recorded walkthrough
            </button>
            <button
              aria-pressed={mode === "live"}
              onClick={() => setMode("live")}
            >
              Your words · live Jev
            </button>
          </div>
          {mode === "recorded" ? (
            <div className="wardrobe-recorded">
              <div className="wardrobe-progress">
                {DEMO_COMMANDS.map((c, i) => (
                  <span key={c.id} className={i < demoStep ? "done" : ""}>
                    {i + 1}
                  </span>
                ))}
                <small>
                  {demoStep === 4
                    ? "Whole look, intact."
                    : "ONE CHANGE AT A TIME"}
                </small>
              </div>
              <p>“{demo.text}”</p>
              <button
                className="wardrobe-primary"
                onClick={replay}
                disabled={!demoRows[demoStep % 4]?.response}
              >
                {demoStep === 4
                  ? "Replay from the jacket"
                  : "Apply recorded Jev edit"}
                <ArrowRight size={16} />
              </button>
              <small>
                Authored text → recorded Jev decisions. The illustrated preview
                is drawn by code.
              </small>
            </div>
          ) : (
            <form
              className="wardrobe-input"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label htmlFor="wardrobe-command">What would you change?</label>
              <textarea
                id="wardrobe-command"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setTranscriptSource("typed");
                }}
                placeholder="Put on the formal jacket with lapels…"
                maxLength={1000}
              />
              <div>
                <button type="button" aria-pressed={listening} onClick={listen}>
                  <Mic size={16} />
                  {listening ? "Stop listening" : "Dictate"}
                </button>
                <button
                  className="wardrobe-primary"
                  disabled={busy || !text.trim()}
                >
                  {busy ? "Jev is choosing…" : "Send to Jev"}
                  <ArrowRight size={16} />
                </button>
              </div>
              <small>
                Dictation starts only when pressed. Your browser may send audio
                to its speech service. Review the transcript before sending; Jev
                receives text and clothing metadata, never video or audio.
              </small>
            </form>
          )}
          <div className="wardrobe-response" role="status">
            <Sparkles size={17} />
            <p>{message}</p>
          </div>
          <div className="wardrobe-history-actions">
            <button onClick={undo} disabled={!history.length}>
              <Undo2 size={14} />
              Undo
            </button>
            <button onClick={reset}>
              <RotateCcw size={14} />
              Start over
            </button>
            <button aria-pressed={speak} onClick={() => setSpeak(!speak)}>
              <Volume2 size={14} />
              {speak ? "Voice on" : "Read replies"}
            </button>
          </div>
          <div className="wardrobe-rack-heading">
            <h3>The wardrobe</h3>
            <div>
              <button
                aria-pressed={slot === "jacket"}
                onClick={() => setSlot("jacket")}
              >
                <Shirt size={15} />
                Layers
              </button>
              <button
                aria-pressed={slot === "glasses"}
                onClick={() => setSlot("glasses")}
              >
                <Glasses size={16} />
                Shades
              </button>
            </div>
          </div>
          <div className="wardrobe-rack">
            {CATALOG.filter((i) => i.slot === slot).map((i) => (
              <button
                key={i.id}
                aria-pressed={selected === i.id}
                className="wardrobe-piece"
                onClick={() =>
                  manual(
                    i.slot === "jacket"
                      ? {
                          jacket: i.id as Outfit["jacket"],
                          jacketColor: (i.colors as readonly string[]).includes(
                            outfit.jacketColor,
                          )
                            ? outfit.jacketColor
                            : i.defaultColor,
                        }
                      : {
                          glasses: i.id as Outfit["glasses"],
                          glassesColor: (
                            i.colors as readonly string[]
                          ).includes(outfit.glassesColor)
                            ? outfit.glassesColor
                            : i.defaultColor,
                        },
                    `Choose ${i.name}`,
                  )
                }
              >
                <span className="wardrobe-thumbnail">
                  <img
                    src={garmentImage(
                      i.id,
                      selected === i.id ? color : i.defaultColor,
                    )}
                    alt={`${i.type} reference illustration`}
                  />
                  {selected === i.id && <Check size={15} />}
                </span>
                <strong>{i.name}</strong>
                <small>{i.tags.slice(0, 2).join(" · ")}</small>
              </button>
            ))}
          </div>
          {selectedItem && (
            <div className="wardrobe-adjust">
              <div>
                <span>COLOR · {color}</span>
                <div className="wardrobe-swatches">
                  {selectedItem.colors.map((c) => (
                    <button
                      key={c}
                      style={{ background: COLORS[c] }}
                      aria-label={`${c} ${slot}`}
                      aria-pressed={color === c}
                      onClick={() =>
                        manual(
                          slot === "jacket"
                            ? { jacketColor: c }
                            : { glassesColor: c },
                          `Make ${slot} ${c}`,
                        )
                      }
                    >
                      {color === c && <Check size={13} />}
                    </button>
                  ))}
                </div>
              </div>
              <label>
                {slot === "jacket" ? "FIT" : "FRAME SIZE"}
                <select
                  value={slot === "jacket" ? outfit.fit : outfit.glassesSize}
                  onChange={(e) =>
                    manual(
                      slot === "jacket"
                        ? { fit: e.target.value as Outfit["fit"] }
                        : {
                            glassesSize: e.target
                              .value as Outfit["glassesSize"],
                          },
                      `Change ${slot} size`,
                    )
                  }
                >
                  {(slot === "jacket"
                    ? ["fitted", "regular", "oversized"]
                    : ["small", "regular", "large"]
                  ).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <button
                aria-label={`Remove ${slot}`}
                onClick={() =>
                  manual(
                    slot === "jacket"
                      ? { jacket: "none" }
                      : { glasses: "none" },
                    `Remove ${slot}`,
                  )
                }
              >
                <X size={15} />
              </button>
            </div>
          )}
          <p className="wardrobe-catalog-note">
            Original reference illustrations with explicit material, shape and
            style tags. Experimental virtual styling; no fit prediction or
            purchase.
          </p>
        </section>
      </div>
      {showConnect && (
        <section className="wardrobe-connect">
          <div>
            <span className="wardrobe-eyebrow">A REAL VIDEO CONNECTION</span>
            <h3>Bring the look to life.</h3>
            <p>
              Lucy 2.1 via fal receives the chosen video source, full outfit
              prompt and illustrated garment reference. Jev receives only your
              command and clothing metadata. A short-lived token passes through
              this app; video goes directly to the provider.
            </p>
            <p>
              About $0.02/second, billed to your fal account. Each connection
              stops after {SESSION_SECONDS} seconds (about $1.20 maximum model
              time). Your key stays in this page’s memory and is forgotten on
              disconnect. This app does not save live frames; provider
              processing and retention policies apply.
            </p>
            <a
              href="https://fal.ai/models/decart/lucy2-vton/realtime"
              target="_blank"
              rel="noreferrer"
            >
              Model and pricing ↗
            </a>
          </div>
          <div>
            <label>
              YOUR FAL API KEY
              <input
                type="password"
                value={falKey}
                onChange={(e) => setFalKey(e.target.value)}
                autoComplete="off"
                placeholder="Kept in memory for this connection"
              />
            </label>
            <label>
              VIDEO SOURCE
              <select
                value={inputSource}
                onChange={(e) => {
                  setInputSource(e.target.value as any);
                  setConsent(false);
                }}
              >
                <option value="illustration">
                  Illustrated presenter · no camera
                </option>
                <option value="camera">My camera · explicit opt-in</option>
              </select>
            </label>
            <label className="wardrobe-consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                I agree to send{" "}
                {inputSource === "camera"
                  ? "my camera video"
                  : "the illustrated presenter video"}{" "}
                to fal/Decart and use my fal credits. No microphone is
                requested.
              </span>
            </label>
            <button
              className="wardrobe-primary"
              onClick={() => void connect()}
              disabled={!consent || !falKey.trim() || videoStatus !== "off"}
            >
              {inputSource === "camera"
                ? "Allow camera & connect"
                : "Connect illustrated presenter"}
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
      )}
      {videoError && (
        <p className="wardrobe-error" role="alert">
          {videoError} The code avatar is available and is labeled separately.
        </p>
      )}
      <section className="wardrobe-inspector">
        <button
          className="wardrobe-inspector-toggle"
          onClick={() => setInspect(!inspect)}
          aria-expanded={inspect}
        >
          <span>
            Behind the change{" "}
            <small>Outfit state, decisions & video provenance</small>
          </span>
          <ChevronDown size={18} />
        </button>
        {inspect && (
          <div className="wardrobe-inspector-body">
            <div>
              <h4>One complete outfit</h4>
              <pre>{JSON.stringify(outfit, null, 2)}</pre>
              <h4>
                Complete video prompt · revision {ticket.current.revision}
              </h4>
              <p>{fullPrompt(outfit)}</p>
              <small>
                Each accepted edit sends this entire outfit. Provider
                acknowledgement is not proof that a particular frame reflects
                the newest revision.
              </small>
              <h4>Reference sent to Lucy</h4>
              <img
                className="wardrobe-reference"
                src={referenceData(outfit)}
                alt="Composite illustrated reference of current jacket and sunglasses"
              />
              <p>
                Code produces references from the same catalog metadata used by
                Jev.
              </p>
            </div>
            <div>
              <h4>Decision history</h4>
              {turns.length ? (
                turns.map((t) => (
                  <details key={t.id}>
                    <summary>
                      {t.text}
                      <small>
                        {t.provenance} · {t.source}
                      </small>
                    </summary>
                    {t.reason && <p>{t.reason}</p>}
                    <pre>
                      {JSON.stringify(
                        { before: t.before, after: t.after, raw: t.raw },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))
              ) : (
                <p>No edits yet.</p>
              )}
              <h4>Recorded coverage</h4>
              <p>
                {result?.coverage?.completed ?? 0}/
                {result?.coverage?.planned ?? 12} authored cases;{" "}
                {result?.metrics?.exact ?? 0} exact guarded outcomes;{" "}
                {result?.metrics?.rawExact ?? 0} raw Jev exact. Development
                fixture, one wording per case. The focus guard was developed on
                this fixture.
              </p>
              <h4>Video evidence</h4>
              <p>
                {recording?.status === "complete"
                  ? recording?.spoken
                    ? `Actual ${Number(recording.actualRecordedSeconds).toFixed(1)} second Lucy video with synthetic spoken commands. Local MLX Whisper transcribed the audio; genuine Jev responses for those identical transcripts produced the guarded outfit states. Those states are replayed on a 7.5-second schedule. Playback timing is not live end-to-end latency. The clip is separate from your current outfit. Generated clothing proportions and unedited details drift; the final frame-size increase is not conclusive.`
                    : `Actual ${Number(recording.actualRecordedSeconds).toFixed(1)} second Lucy recording from the original illustrated presenter. Outfit states and commands were authored, not Jev-selected or speech-transcribed. Its video is separate from the current interactive outfit.`
                  : (recording?.error ??
                    "No generated recording is available. The animated presenter is an original code illustration.")}
              </p>
              {pipeline?.turns && (
                <div className="wardrobe-stage-timings">
                  <h4>Recorded pipeline timings</h4>
                  <p>
                    Synthetic Samantha voice, 145 words/minute. Local Whisper
                    base.en. These are original stage timings, not the replay
                    schedule.
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>Command</th>
                        <th>Speech</th>
                        <th>STT</th>
                        <th>Jev</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pipeline.turns.map((turn: any) => (
                        <tr key={turn.id}>
                          <td>{turn.text}</td>
                          <td>{turn.seconds.toFixed(1)}s</td>
                          <td>{turn.transcriptionMs}ms</td>
                          <td>{turn.rawResponse.latency_ms}ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p>
                    The pink edit includes a code guard: raw Jev also changed
                    jacketColor; the focus rule preserves the jacket.
                    Camera/microphone were not used for this recording.
                  </p>
                </div>
              )}
              {events.length > 0 && (
                <pre>
                  {events
                    .map(
                      (e) =>
                        `${(e.elapsedMs / 1000).toFixed(1)}s ${e.type}${e.revision !== undefined ? ` · revision ${e.revision}` : ""}`,
                    )
                    .join("\n")}
                </pre>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
