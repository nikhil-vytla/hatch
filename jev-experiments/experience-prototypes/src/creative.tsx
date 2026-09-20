import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Play,
  Pause,
  Download,
  LockKeyhole,
  Volume2,
  VolumeX,
  Shuffle,
} from "lucide-react";
import {
  Pane,
  Field,
  Button,
  RunButton,
  Pills,
  Notice,
  State,
  useRun,
  ErrorText,
} from "./shared";
import { run, choice, judge, download, pretty } from "./api";
import { MotionArt } from "./motion-art";
export function Worlds({ result }: { result: any }) {
  const rows = (result.scenes ?? []).filter((r: any) => !r.error),
    [index, setIndex] = useState(0),
    [brief, setBrief] = useState(rows[0]?.brief ?? "A quiet moonlit garden"),
    [row, setRow] = useState<any>(rows[0]),
    [paused, setPaused] = useState(false);
  const { busy, error, execute } = useRun();
  return (
    <div className="workbench">
      <div className="artifact-column">
        <div className="world-stage">
          <MotionArt
            scene={`${row?.scene?.terrain === "buildings" ? "city " : ""}${row?.scene?.palette ?? "garden"}`}
            paused={paused}
            parameters={row?.scene ?? {}}
          />
          <div className="world-caption">
            <span>AN INTERPRETATION OF</span>
            <h2>{row?.brief ?? brief}</h2>
            <Button secondary onClick={() => setPaused(!paused)}>
              {paused ? <Play size={14} /> : <Pause size={14} />}{" "}
              {paused ? "Resume" : "Pause"} motion
            </Button>
          </div>
        </div>
        <div className="decision-chips">
          {Object.entries(row?.scene ?? {}).map(([k, v]) => (
            <span key={k}>
              <small>{pretty(k)}</small>
              {pretty(v)}
            </span>
          ))}
        </div>
      </div>
      <aside className="controls">
        <Pane title="Give the world a feeling">
          <Field label="Scene brief">
            <textarea
              rows={5}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
          </Field>
          <RunButton
            busy={busy}
            label="Imagine this world"
            onClick={() =>
              execute(async () => {
                const r = await run(brief, {
                  palette: choice("Choose the visual palette", [
                    "garden",
                    "night",
                    "ocean",
                    "warm",
                    "neon",
                  ]),
                  terrain: choice("Choose the environment", [
                    "hills",
                    "buildings",
                    "waves",
                    "stars",
                  ]),
                  motion: choice("Choose the feeling of movement", [
                    "drift",
                    "orbit",
                    "pulse",
                    "grow",
                  ]),
                  density: choice("Choose how crowded", [
                    "sparse",
                    "balanced",
                    "dense",
                  ]),
                });
                setRow({
                  brief,
                  scene: Object.fromEntries(
                    Object.entries(r.answers).map(([k, a]: any) => [
                      k,
                      a.value,
                    ]),
                  ),
                  ...r,
                });
              })
            }
          />
          <Field label="Recorded worlds">
            <select
              value={index}
              onChange={(e) => {
                const i = Number(e.target.value);
                setIndex(i);
                setRow(rows[i]);
                setBrief(rows[i].brief);
              }}
            >
              {rows.map((r: any, i: number) => (
                <option value={i} key={i}>
                  {r.brief}
                </option>
              ))}
            </select>
          </Field>
          <p className="fine">
            Jev chooses semantic scene parameters. A procedural renderer
            interprets them. Object-specific rendering is still limited, and the
            visible scene should be judged against its brief.
          </p>
          <ErrorText error={error} />
          <State value={row} />
        </Pane>
      </aside>
    </div>
  );
}
const objectTypes = [
  "house",
  "tree",
  "cat",
  "robot",
  "flower",
  "pond",
  "mountain",
  "moon",
  "cloud",
];
const colors = {
  night: ["#142032", "#31445c", "#7296a3", "#edd4a0", "#da8167"],
  garden: ["#203c35", "#4b6e4d", "#9db38b", "#eddda9", "#da886e"],
  warm: ["#302436", "#8e5454", "#d59c72", "#f6dfb1", "#759e91"],
  neon: ["#211e3b", "#514377", "#a586cf", "#f3c8e7", "#66bfb0"],
};
export function paintPixels(
  canvas: HTMLCanvasElement,
  plan: any,
  mode: string,
  time = 0,
) {
  const ctx = canvas.getContext("2d")!;
  const n = 64;
  canvas.width = n;
  canvas.height = n;
  ctx.imageSmoothingEnabled = false;
  const p = colors[plan.palette as keyof typeof colors] ?? colors.night;
  ctx.fillStyle = mode === "sprites" ? "#00000000" : p[0];
  ctx.clearRect(0, 0, n, n);
  ctx.fillRect(0, 0, n, n);
  const rect = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(
      Math.round(x),
      Math.round(y),
      Math.max(1, Math.round(w)),
      Math.max(1, Math.round(h)),
    );
  };
  if (mode === "patterns") {
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const k = Math.floor(
          (Math.sin(x * 0.16 + time) +
            Math.cos(y * 0.17 - time) +
            Math.sin((x + y) * 0.1 + time * 0.5)) *
            1.2 +
            3,
        );
        rect(x, y, 1, 1, p[((k % p.length) + p.length) % p.length]);
      }
    return;
  }
  if (mode === "scenes") {
    for (let x = 0; x < 64; x++)
      rect(x, 45 + Math.sin(x * 0.12) * 3, 1, 22, p[1]);
    if (plan.weather === "rain") {
      for (let i = 0; i < 26; i++)
        rect((i * 17) % 64, (i * 23 + time * 18) % 54, 1, 3, p[2]);
    }
  }
  for (const [i, kind] of objectTypes.entries()) {
    if (!plan[kind]) continue;
    const x = Number(
        plan[kind + "_x"] ?? [20, 49, 34, 31, 12, 39, 50, 50, 12][i],
      ),
      y = Number(plan[kind + "_y"] ?? [32, 38, 45, 35, 42, 51, 28, 12, 16][i]);
    if (kind === "house") {
      rect(x - 10, y - 2, 22, 21, p[2]);
      for (let j = 0; j < 7; j++)
        rect(x - 13 + j, y - 9 + j, 28 - j * 2, 1, p[4]);
      rect(x - 9, y + 4, 8, 7, p[3]);
      rect(x + 4, y + 7, 5, 12, p[0]);
      rect(x - 12, y + 1, 26, 3, p[4]);
      rect(x - 9, y + 19, 22, 2, p[0]);
    }
    if (kind === "tree") {
      rect(x - 1, y, 3, 15, p[4]);
      for (let j = 0; j < 13; j++) rect(x - j / 2, y - 13 + j, j + 3, 1, p[2]);
    }
    if (kind === "cat") {
      rect(x - 3, y, 7, 5, p[3]);
      rect(x - 2, y - 3, 5, 4, p[3]);
      rect(x - 2, y - 5, 1, 2, p[3]);
      rect(x + 2, y - 5, 1, 2, p[3]);
      rect(x - 1, y - 1, 1, 1, p[0]);
      rect(x + 1, y - 1, 1, 1, p[0]);
      rect(x + 4, y + 1, 3, 2, p[3]);
    }
    if (kind === "robot") {
      rect(x - 6, y - 13, 13, 10, p[2]);
      rect(x - 5, y - 1, 11, 14, p[2]);
      rect(x - 4, y - 9, 3, 3, p[3]);
      rect(x + 2, y - 9, 3, 3, p[3]);
      rect(x - 2, y - 16, 4, 3, p[4]);
      rect(x - 5, y + 14, 3, 5, p[3]);
      rect(x + 3, y + 14, 3, 5, p[3]);
      rect(x - 9, y + 2, 3, 8, p[4]);
      rect(x + 8, y + 2, 3, 8, p[4]);
    }
    if (kind === "flower") {
      rect(x, y, 1, 10, p[2]);
      rect(x - 4, y - 3, 9, 4, p[4]);
      rect(x - 2, y - 6, 5, 10, p[4]);
      rect(x - 1, y - 2, 3, 3, p[3]);
    }
    if (kind === "pond") {
      for (let j = 0; j < 5; j++) rect(x - 10 + j, y + j, 21 - 2 * j, 1, p[0]);
      rect(x - 6 + Math.sin(time) * 2, y + 1, 8, 1, p[2]);
    }
    if (kind === "moon") {
      rect(x - 3, y - 4, 6, 8, p[3]);
      rect(x - 4, y - 3, 8, 6, p[3]);
      rect(x, y - 4, 5, 6, p[0]);
    }
    if (kind === "mountain")
      for (let j = 0; j < 18; j++)
        rect(x - j, y + j, 2 * j, 1, j < 5 ? p[3] : p[1]);
    if (kind === "cloud") {
      rect(x - 6, y, 16, 4, p[2]);
      rect(x - 3, y - 3, 8, 4, p[2]);
    }
  }
}
export function pixelQuestions(mode: string) {
  const questions: Record<string, any> = {
    palette: choice("Choose a palette to fit the brief", Object.keys(colors)),
    weather: choice("Choose the weather", ["clear", "rain"]),
  };
  for (const k of objectTypes) {
    questions[k] = judge(`Should a ${k} appear in the requested ${mode}?`);
    questions[k + "_x"] = choice(
      `Where horizontally should the ${k} be centered on a 64-pixel-wide canvas?`,
      ["12", "24", "32", "44", "52"],
    );
    questions[k + "_y"] = choice(
      `Where vertically should the ${k} be placed on a 64-pixel-high canvas? Top is 0.`,
      ["12", "24", "36", "44", "52"],
    );
  }
  return questions;
}
export const initialPixelPlan = {
  palette: "night",
  house: true,
  cat: true,
  moon: true,
  tree: true,
  pond: true,
  weather: "rain",
};
export function Pixels({ result }: { result: any }) {
  const [mode, setMode] = useState("scenes"),
    [brief, setBrief] = useState(
      "A tiny noodle shop on a rainy street at midnight, with one warm window and a cat under the awning.",
    ),
    [plan, setPlan] = useState<any>(initialPixelPlan),
    [history, setHistory] = useState<any[]>([initialPixelPlan]),
    [locked, setLocked] = useState(false),
    [last, setLast] = useState<any>(null);
  useEffect(() => {
    const r = result.compositions?.find((r: any) => r.mode === mode);
    if (r) {
      setPlan(r.plan);
      setBrief(r.brief);
      setLast({ ...r, source: "recorded" });
      setHistory([r.plan]);
    } else setLast(null);
  }, [result, mode]);
  const ref = useRef<HTMLCanvasElement>(null),
    { busy, error, execute } = useRun();
  useEffect(() => {
    let f = 0;
    const start = performance.now();
    const draw = () => {
      paintPixels(
        ref.current!,
        plan,
        mode,
        matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : (performance.now() - start) / 1000,
      );
      f = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(f);
  }, [plan, mode]);
  return (
    <div className="workbench">
      <div className="artifact-column">
        <Pills
          values={["scenes", "sprites", "patterns"]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            if (m === "sprites") {
              setPlan({ palette: "garden", robot: true });
              setBrief(
                "A friendly gardening robot with warm eyes, as a game sprite.",
              );
            } else if (m === "patterns")
              setBrief("An ocean-like field of slowly changing colors.");
            else setPlan(initialPixelPlan);
          }}
        />
        <div className={"pixel-stage " + mode}>
          <canvas ref={ref} aria-label="64 by 64 generated pixel composition" />
          <div className="pixel-meta">
            <span>64 × 64</span>
            <span>
              {last
                ? "JEV-CONTROLLED COMPOSITION"
                : "PREPARED STARTING COMPOSITION"}
            </span>
          </div>
        </div>
        <div className="version-strip">
          {history.map((p, i) => (
            <button key={i} onClick={() => setPlan(p)}>
              <strong>Version {i + 1}</strong>
              <span>
                {p.palette} ·{" "}
                {objectTypes.filter((k) => p[k]).join(", ") || "pattern"}
              </span>
            </button>
          ))}
        </div>
      </div>
      <aside className="controls">
        <Pane title="Small pixels, deliberate choices">
          <Field label="Describe the picture">
            <textarea
              rows={5}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={locked}
              onChange={(e) => setLocked(e.target.checked)}
            />
            <LockKeyhole size={13} /> Keep the palette
          </label>
          <RunButton
            busy={busy}
            label="Compose the picture"
            onClick={() =>
              execute(async () => {
                const questions = pixelQuestions(mode);
                const r = await run({ brief, mode, current: plan }, questions);
                const p: any = Object.fromEntries(
                  Object.entries(r.answers).map(([k, a]: any) => [
                    k,
                    objectTypes.includes(k) ? a.value >= 0.5 : a.value,
                  ]),
                );
                if (locked) p.palette = plan.palette;
                setPlan(p);
                setHistory((h) => [...h, p]);
                setLast(r);
              })
            }
          />
          <Button
            secondary
            onClick={() => {
              const a = document.createElement("a");
              a.href = ref.current!.toDataURL();
              a.download = "jev-pixels.png";
              a.click();
            }}
          >
            <Download size={14} /> Export PNG
          </Button>
          <ErrorText error={error} />
          <p className="fine">
            This prototype tests composition with a visible library of pixel
            objects. Jev chooses inclusion, placement, palette, and weather. The
            drawing code supplies object shapes; it is not unrestricted image
            generation.
          </p>
          <State value={{ plan, objectsAvailable: objectTypes, run: last }} />
        </Pane>
      </aside>
    </div>
  );
}
export function Music({ result }: { result: any }) {
  const rows = (result.rows ?? []).filter((r: any) => !r.error),
    [index, setIndex] = useState(0),
    [row, setRow] = useState<any>(rows[0]),
    [bpm, setBpm] = useState(rows[0]?.bpm ?? 85),
    [playing, setPlaying] = useState(false),
    [beat, setBeat] = useState(-1),
    [mutes, setMutes] = useState<string[]>([]),
    [brief, setBrief] = useState(
      "A quiet melody that grows into a hopeful little arrangement.",
    ),
    [arrangement, setArrangement] = useState({
      harmony: "warm",
      rhythm: "gentle",
      form: "ABAB",
    }),
    [last, setLast] = useState<any>(null);
  const engine = useRef<any>(null),
    muted = useRef(mutes);
  muted.current = mutes;
  const { busy, error, execute } = useRun();
  const notes = row?.notes ?? [
    { midi: 60, beats: 1 },
    { midi: 64, beats: 1 },
    { midi: 67, beats: 1 },
    { midi: 65, beats: 1 },
    { midi: 62, beats: 1 },
    { midi: 64, beats: 1 },
    { midi: 67, beats: 1 },
    { midi: 60, beats: 1 },
  ];
  const stop = () => {
    engine.current?.stop();
    engine.current = null;
    setPlaying(false);
    setBeat(-1);
  };
  useEffect(() => () => engine.current?.stop(), []);
  async function play() {
    if (playing) {
      stop();
      return;
    }
    const Tone = await import("tone");
    await Tone.start();
    const melody = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.04, decay: 0.2, sustain: 0.2, release: 0.8 },
    }).toDestination();
    melody.volume.value = -17;
    const bass = new Tone.Synth({
      oscillator: { type: "sine" },
    }).toDestination();
    bass.volume.value = -22;
    const chords = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sine" },
      envelope: { attack: 0.2, decay: 0.5, sustain: 0.2, release: 1.5 },
    }).toDestination();
    chords.volume.value = -26;
    const drum = new Tone.MembraneSynth().toDestination();
    drum.volume.value = -29;
    const transport = Tone.getTransport();
    transport.cancel();
    transport.bpm.value = bpm;
    let step = 0;
    const loop = new Tone.Loop((time) => {
      const i = step % 32,
        n = notes[i % notes.length],
        variation = (
          arrangement.form === "ABAB"
            ? (i >= 8 && i < 16) || i >= 24
            : i >= 16 && i < 24
        )
          ? 2
          : 0;
      Tone.getDraw().schedule(() => setBeat(i), time);
      if (!muted.current.includes("Melody"))
        melody.triggerAttackRelease(
          Tone.Frequency(n.midi + variation, "midi").toFrequency(),
          "8n",
          time,
        );
      if (i % 4 === 0) {
        const root = [48, 53, 55, 48][Math.floor(i / 8) % 4];
        if (!muted.current.includes("Bass"))
          bass.triggerAttackRelease(
            Tone.Frequency(root - 12, "midi").toFrequency(),
            "2n",
            time,
          );
        if (!muted.current.includes("Harmony"))
          chords.triggerAttackRelease(
            [
              root,
              root +
                (arrangement.harmony === "warm"
                  ? 4
                  : arrangement.harmony === "suspended"
                    ? 5
                    : 3),
              root + 7,
            ].map((x) => Tone.Frequency(x, "midi").toFrequency()),
            "2n",
            time,
          );
      }
      if (
        !muted.current.includes("Rhythm") &&
        (i % 2 === 0 || arrangement.rhythm === "driving")
      )
        drum.triggerAttackRelease("C2", "16n", time);
      step++;
    }, "8n").start(0);
    transport.start();
    engine.current = {
      stop: () => {
        transport.stop();
        transport.cancel();
        loop.dispose();
        melody.dispose();
        bass.dispose();
        chords.dispose();
        drum.dispose();
      },
    };
    setPlaying(true);
  }
  return (
    <div className="workbench">
      <div className="artifact-column">
        <div className="music-stage">
          <div className="music-heading">
            <span className="eyebrow">A MOTIF BECOMES AN ARRANGEMENT</span>
            <h2>{row?.brief ?? brief}</h2>
            <p>Melody · harmony · bass · rhythm</p>
          </div>
          <div className="piano-roll">
            {Array.from({ length: 32 }, (_, i) => (
              <div
                key={i}
                className={"piano-column " + (beat === i ? "playing" : "")}
                onClick={() => {
                  const updated = [...notes];
                  updated[i % notes.length] = {
                    ...notes[i % notes.length],
                    midi: notes[i % notes.length].midi + 1,
                  };
                  setRow({ ...row, notes: updated });
                  stop();
                }}
              >
                <span
                  style={{
                    bottom:
                      ((notes[i % notes.length].midi - 55) % 24) * 3 + 12 + "%",
                    height: "9px",
                  }}
                />
                <i>{i % 8 === 0 ? `0${i / 8 + 1}` : ""}</i>
              </div>
            ))}
          </div>
          <div className="track-controls">
            {["Melody", "Harmony", "Bass", "Rhythm"].map((n) => (
              <button
                key={n}
                className={mutes.includes(n) ? "muted-track" : ""}
                onClick={() =>
                  setMutes((s) =>
                    s.includes(n) ? s.filter((x) => x !== n) : [...s, n],
                  )
                }
              >
                {mutes.includes(n) ? (
                  <VolumeX size={14} />
                ) : (
                  <Volume2 size={14} />
                )}{" "}
                {n}
              </button>
            ))}
          </div>
          <div className="playback">
            <Button onClick={() => play()}>
              {playing ? <Pause size={15} /> : <Play size={15} />}{" "}
              {playing ? "Stop" : "Listen to the arrangement"}
            </Button>
            <span>{bpm} BPM</span>
          </div>
        </div>
        <Notice>
          The recorded melody comes from Jev. The arrangement is procedural;
          “Arrange with Jev” changes its musical choices. Click a note column to
          raise that motif note.
        </Notice>
      </div>
      <aside className="controls">
        <Pane title="Conduct the next version">
          <Field label="Musical direction">
            <textarea
              rows={4}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
          </Field>
          <Field label={`Tempo · ${bpm} BPM`}>
            <input
              type="range"
              min="50"
              max="160"
              value={bpm}
              onChange={(e) => {
                setBpm(Number(e.target.value));
                stop();
              }}
            />
          </Field>
          <Field label="Recorded motif">
            <select
              value={index}
              onChange={(e) => {
                const i = Number(e.target.value);
                stop();
                setIndex(i);
                setRow(rows[i]);
                setBpm(rows[i].bpm);
              }}
            >
              {rows.map((r: any, i: number) => (
                <option value={i} key={i}>
                  {r.brief}
                </option>
              ))}
            </select>
          </Field>
          <RunButton
            busy={busy}
            label="Arrange with Jev"
            onClick={() =>
              execute(async () => {
                stop();
                const r = await run(
                  { brief, motif: notes },
                  {
                    harmony: choice("Choose the harmonic feeling", [
                      "warm",
                      "suspended",
                      "dark",
                    ]),
                    rhythm: choice("Choose the rhythmic density", [
                      "gentle",
                      "driving",
                    ]),
                    form: choice("Choose a musical phrase structure", [
                      "ABAB",
                      "AABA",
                    ]),
                  },
                );
                setArrangement(
                  Object.fromEntries(
                    Object.entries(r.answers).map(([k, a]: any) => [
                      k,
                      a.value,
                    ]),
                  ) as any,
                );
                setLast(r);
              })
            }
          />
          <Button
            secondary
            onClick={() =>
              download("jev-arrangement.json", {
                notes,
                bpm,
                arrangement,
                mutes,
              })
            }
          >
            <Download size={14} /> Export score
          </Button>
          <Button
            secondary
            onClick={async () => {
              const { Midi } = await import("@tonejs/midi");
              const midi = new Midi();
              midi.name = "Jev small orchestra";
              midi.header.setTempo(bpm);
              const tracks = ["Melody", "Harmony", "Bass", "Rhythm"].map(
                (name) => {
                  const track = midi.addTrack();
                  track.name = name;
                  return track;
                },
              );
              tracks[2].instrument.number = 32;
              tracks[3].channel = 9;
              const quarter = midi.header.ppq;
              for (let i = 0; i < 32; i++) {
                const ticks = (i * quarter) / 2,
                  variation = (
                    arrangement.form === "ABAB"
                      ? (i >= 8 && i < 16) || i >= 24
                      : i >= 16 && i < 24
                  )
                    ? 2
                    : 0;
                if (!mutes.includes("Melody"))
                  tracks[0].addNote({
                    midi: notes[i % notes.length].midi + variation,
                    ticks,
                    durationTicks: quarter * 0.45,
                    velocity: 0.7,
                  });
                if (i % 4 === 0) {
                  const root = [48, 53, 55, 48][Math.floor(i / 8) % 4];
                  if (!mutes.includes("Bass"))
                    tracks[2].addNote({
                      midi: root - 12,
                      ticks,
                      durationTicks: quarter * 1.8,
                      velocity: 0.6,
                    });
                  if (!mutes.includes("Harmony"))
                    for (const pitch of [
                      root,
                      root +
                        (arrangement.harmony === "warm"
                          ? 4
                          : arrangement.harmony === "suspended"
                            ? 5
                            : 3),
                      root + 7,
                    ])
                      tracks[1].addNote({
                        midi: pitch,
                        ticks,
                        durationTicks: quarter * 1.8,
                        velocity: 0.45,
                      });
                }
                if (
                  !mutes.includes("Rhythm") &&
                  (i % 2 === 0 || arrangement.rhythm === "driving")
                )
                  tracks[3].addNote({
                    midi: 36,
                    ticks,
                    durationTicks: quarter * 0.2,
                    velocity: 0.5,
                  });
              }
              const url = URL.createObjectURL(
                new Blob([new Uint8Array(midi.toArray()).buffer], {
                  type: "audio/midi",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "jev-arrangement.mid";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Download size={14} /> Export MIDI
          </Button>
          <ErrorText error={error} />
          <State value={{ notes, bpm, arrangement, mutes, run: last }} />
        </Pane>
      </aside>
    </div>
  );
}
