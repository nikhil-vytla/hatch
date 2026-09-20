import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  Play,
  Pause,
  RotateCcw,
  ChevronRight,
  Gamepad2,
  Radio,
} from "lucide-react";
import { Pane, Button, Stat, Fold, State as StateView, Notice } from "./shared";
import { run, getApiKey } from "./api";
import {
  initial,
  step as advance,
  observe,
  options,
  question,
  type State,
  type Game,
} from "../../local-models-and-games/arcade/engine";

function SnakeBoard({ state }: { state: State }) {
  const reduced = useReducedMotion();
  const points = state
    .snake!.map((p) => `${p.x * 36 + 38},${p.y * 36 + 38}`)
    .join(" ");
  const head = state.snake![0];
  return (
    <svg
      className="snake-board"
      viewBox="0 0 400 400"
      role="img"
      aria-label={`Snake board. ${state.score} food collected. Head at ${head.x}, ${head.y}.`}
    >
      <defs>
        <pattern
          id="snake-grid"
          width="36"
          height="36"
          patternUnits="userSpaceOnUse"
          x="20"
          y="20"
        >
          <rect
            width="36"
            height="36"
            fill="none"
            stroke="currentColor"
            strokeOpacity=".08"
          />
        </pattern>
      </defs>
      <rect
        x="20"
        y="20"
        width="360"
        height="360"
        rx="10"
        fill="url(#snake-grid)"
        stroke="currentColor"
        strokeOpacity=".14"
      />
      <motion.circle
        initial={false}
        cx={state.food!.x * 36 + 38}
        cy={state.food!.y * 36 + 38}
        r={8}
        fill="#ef987d"
        animate={reduced ? {} : { r: [7, 10, 7] }}
        transition={{ duration: 1.4, repeat: Infinity }}
      />
      <polyline
        points={points}
        fill="none"
        stroke="#9bca9e"
        strokeWidth="24"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity=".82"
      />
      <motion.circle
        initial={false}
        cx={head.x * 36 + 38}
        cy={head.y * 36 + 38}
        animate={{ cx: head.x * 36 + 38, cy: head.y * 36 + 38 }}
        transition={{ duration: reduced ? 0 : 0.16 }}
        r={13}
        fill="#d6edc8"
      />
      <circle
        cx={head.x * 36 + 38}
        cy={head.y * 36 + 38}
        r="3"
        fill="#173125"
      />
    </svg>
  );
}
function OrbitalScene({ state }: { state: State }) {
  const host = useRef<HTMLDivElement>(null),
    latest = useRef(state);
  latest.current = state;
  const [error, setError] = useState("");
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setError(
        "3D rendering is unavailable in this browser. The state and decisions remain below.",
      );
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor("#101d24");
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog("#101d24", 28, 70);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(12, 10, 14);
    camera.zoom = 1.2;
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 2, 0);
    controls.enableDamping = true;
    controls.minDistance = 9;
    controls.maxDistance = 38;
    controls.maxPolarAngle = Math.PI * 0.48;
    scene.add(new THREE.HemisphereLight("#d7fff2", "#263247", 2));
    const light = new THREE.DirectionalLight("#fff4d2", 3);
    light.position.set(4, 15, 7);
    light.castShadow = true;
    scene.add(light);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: "#13252d", roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.45;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(14, 14, "#456c71", "#294750");
    grid.position.y = -0.4;
    scene.add(grid);
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(12, 5, 12)),
      new THREE.LineBasicMaterial({
        color: "#4e777c",
        transparent: true,
        opacity: 0.32,
      }),
    );
    box.position.y = 2.5;
    scene.add(box);
    const beacon = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.07, 10, 40),
      new THREE.MeshStandardMaterial({
        color: "#9de4d5",
        emissive: "#56a496",
        emissiveIntensity: 1,
      }),
    );
    beacon.rotation.x = -Math.PI / 2;
    beacon.position.set(0, 0.05, 0);
    scene.add(beacon);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.65, 2, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: "#9de4d5",
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
      }),
    );
    beam.position.y = 1;
    scene.add(beam);
    const drone = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32, 1),
      new THREE.MeshStandardMaterial({
        color: "#b6dfdd",
        metalness: 0.5,
        roughness: 0.2,
      }),
    );
    body.castShadow = true;
    drone.add(body);
    const rotors: THREE.Mesh[] = [];
    for (const x of [-0.4, 0.4])
      for (const z of [-0.4, 0.4]) {
        const rotor = new THREE.Mesh(
          new THREE.TorusGeometry(0.22, 0.025, 6, 20),
          new THREE.MeshStandardMaterial({
            color: "#f3e3b8",
            emissive: "#897c41",
          }),
        );
        rotor.rotation.x = Math.PI / 2;
        rotor.position.set(x, 0.06, z);
        drone.add(rotor);
        rotors.push(rotor);
      }
    scene.add(drone);
    const cores = Array.from({ length: 3 }, () => {
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.32),
        new THREE.MeshStandardMaterial({
          color: "#a8e68d",
          emissive: "#5b963a",
          emissiveIntensity: 1.2,
          metalness: 0.25,
          roughness: 0.25,
        }),
      );
      scene.add(m);
      return m;
    });
    const hazards = Array.from({ length: 5 }, () => {
      const g = new THREE.Group();
      const ball = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.55, 1),
        new THREE.MeshStandardMaterial({
          color: "#d47367",
          emissive: "#642d2a",
          wireframe: true,
        }),
      );
      g.add(ball);
      scene.add(g);
      return g;
    });
    const particles = new THREE.BufferGeometry();
    const xyz = [];
    for (let i = 0; i < 120; i++)
      xyz.push(Math.sin(i * 43) * 30, 7 + (i % 18), Math.cos(i * 31) * 30);
    particles.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(xyz, 3),
    );
    scene.add(
      new THREE.Points(
        particles,
        new THREE.PointsMaterial({ color: "#adcfce", size: 0.035 }),
      ),
    );
    const resize = new ResizeObserver(() => {
      const w = el.clientWidth,
        h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resize.observe(el);
    let raf = 0;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = new THREE.Vector3();
    function frame(t: number) {
      const s = latest.current;
      target.set(s.drone!.x, s.drone!.y, s.drone!.z!);
      drone.position.lerp(target, reduce ? 1 : 0.18);
      body.rotation.y = reduce ? 0 : t * 0.001;
      s.cores!.forEach((p, i) => {
        cores[i].visible = true;
        cores[i].position.set(
          p.x,
          p.y + (reduce ? 0 : Math.sin(t * 0.002 + i) * 0.09),
          p.z!,
        );
        cores[i].rotation.y = reduce ? 0 : t * 0.001;
      });
      for (let i = s.cores!.length; i < 3; i++) cores[i].visible = false;
      s.hazards!.forEach((p, i) => {
        hazards[i].position.set(p.x, p.y, p.z!);
        hazards[i].rotation.y = reduce ? 0 : t * 0.0004;
      });
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((x) => x.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div
      className="orbital-canvas"
      ref={host}
      aria-label="Interactive 3D drone rescue arena"
    >
      {error && <p>{error}</p>}
      <span className="camera-hint">Drag to orbit · scroll to zoom</span>
    </div>
  );
}
export function Arcade({ game, result }: { game: Game; result: any }) {
  const episodes = (result.episodes ?? []).filter(
      (e: any) => e.game === game && e.completed,
    ),
    [seed, setSeed] = useState(7),
    [policy, setPolicy] = useState("jev"),
    [mode, setMode] = useState("replay"),
    [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(350),
    [local, setLocal] = useState<State>(() => initial(game, 7)),
    [liveRows, setLiveRows] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null),
    epoch = useRef(0),
    latest = useRef(local);
  latest.current = local;
  const episode =
    episodes.find((e: any) => e.seed === seed && e.policy === policy) ??
    episodes[0];
  const trace = mode === "replay" ? (episode?.trace ?? []) : liveRows;
  const entry = trace[index];
  const state: State =
    mode === "replay"
      ? (entry?.state ?? episode?.state ?? initial(game, seed))
      : local;
  function reset(nextMode = mode, nextSeed = seed) {
    abort.current?.abort();
    epoch.current++;
    setBusy(false);
    setMode(nextMode);
    setPlaying(false);
    setIndex(0);
    setLocal(initial(game, nextSeed));
    setLiveRows([]);
    setError("");
  }
  useEffect(
    () => () => {
      abort.current?.abort();
      epoch.current++;
    },
    [],
  );
  useEffect(() => {
    if (!playing || mode !== "replay") return;
    const t = setInterval(
      () =>
        setIndex((i) => {
          if (i >= trace.length) {
            setPlaying(false);
            return i;
          }
          return i + 1;
        }),
      speed,
    );
    return () => clearInterval(t);
  }, [playing, mode, trace.length, speed]);
  function manual(action: string) {
    if (local.status !== "playing") return;
    const next = advance(local, action);
    setLiveRows((r) => [...r, { state: local, action, source: "you" }]);
    setLocal(next);
    setIndex(liveRows.length);
  }
  async function tick() {
    if (busy || latest.current.status !== "playing") return;
    if (!getApiKey()) {
      setError(
        "Use Connect live in the header to provide your Vercel AI Gateway key.",
      );
      setPlaying(false);
      return;
    }
    const generation = epoch.current;
    const current = latest.current;
    setBusy(true);
    setError("");
    abort.current = new AbortController();
    try {
      const r = await run(
        { policy: "Play the game described in the independent question." },
        { action: question(current) },
        abort.current.signal,
      );
      if (generation !== epoch.current) return;
      const a = r.answers.action;
      setLiveRows((rows) => {
        setIndex(rows.length);
        return [
          ...rows,
          {
            state: current,
            action: a.value,
            probabilities: a.probabilities,
            source: "typesafe-ai/jev",
            latency_ms: r.latency_ms,
          },
        ];
      });
      setLocal(advance(current, a.value));
    } catch (e) {
      if (generation === epoch.current) {
        setError(e instanceof Error ? e.message : String(e));
        setPlaying(false);
      }
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (mode === "live" && playing && !busy && local.status === "playing") {
      const t = setTimeout(tick, 200);
      return () => clearTimeout(t);
    }
  }, [mode, playing, busy, local]);
  const action = mode === "replay" ? (entry ?? trace.at(-1)) : liveRows.at(-1);
  const probabilities = Object.entries(action?.probabilities ?? {}).sort(
    (a: any, b: any) => b[1] - a[1],
  );
  return (
    <div className="arcade-workspace">
      <div className="arcade-toolbar">
        <div className="arcade-modes">
          {[
            ["replay", "Watch Jev"],
            ["live", "Run live"],
            ["manual", "Play yourself"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={mode === id ? "active" : ""}
              onClick={() => reset(id)}
            >
              {id === "manual" ? (
                <Gamepad2 size={15} />
              ) : id === "live" ? (
                <Radio size={15} />
              ) : (
                <Play size={15} />
              )}{" "}
              {label}
            </button>
          ))}
        </div>
        <label>
          Seed{" "}
          <select
            aria-label="Game seed"
            value={seed}
            onChange={(e) => {
              const n = Number(e.target.value);
              setSeed(n);
              reset(mode, n);
            }}
          >
            {[7, 19, 42].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="arcade-layout">
        <div>
          <div
            className="arcade-stage"
            tabIndex={mode === "manual" ? 0 : undefined}
            role="group"
            aria-label="Game arena"
            onKeyDown={(e) => {
              if (mode !== "manual") return;
              const keys: Record<string, string> =
                game === "snake"
                  ? {
                      ArrowLeft: "left",
                      ArrowRight: "right",
                      ArrowUp: "straight",
                    }
                  : {
                      ArrowLeft: "west",
                      ArrowRight: "east",
                      ArrowUp: "north",
                      ArrowDown: "south",
                      w: "up",
                      s: "down",
                    };
              if (keys[e.key]) {
                e.preventDefault();
                e.stopPropagation();
                manual(keys[e.key]);
              }
            }}
          >
            <div className="arcade-hud">
              <div>
                <small>
                  {game === "snake" ? "SNAKE / SURVIVAL" : "ORBITAL / RESCUE"}
                </small>
                <strong>
                  {game === "snake"
                    ? `${state.score} food`
                    : `${state.score} / 3 cores`}
                </strong>
              </div>
              <div>
                <small>
                  {mode === "replay"
                    ? "RECORDED RUN"
                    : mode === "live"
                      ? "LIVE JEV"
                      : "YOUR CONTROLS"}
                </small>
                <strong>{busy ? "Choosing…" : `Move ${state.tick}`}</strong>
              </div>
            </div>
            {game === "snake" ? (
              <SnakeBoard state={state} />
            ) : (
              <OrbitalScene state={state} />
            )}
            <div className="arcade-status">
              {state.status === "playing"
                ? game === "snake"
                  ? "Keep an escape route open."
                  : `Collect the green cores. Return to the beacon. Hull ${state.health}/3.`
                : state.reason}
            </div>
          </div>
          <div className="arcade-playback">
            <Button secondary onClick={() => reset()} aria-label="Restart game">
              <RotateCcw size={16} />
            </Button>
            {mode !== "manual" && (
              <Button
                onClick={() => {
                  if (mode === "replay" && index >= trace.length) setIndex(0);
                  setPlaying(!playing);
                }}
                disabled={mode === "live" && local.status !== "playing"}
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}{" "}
                {playing
                  ? "Pause"
                  : mode === "replay"
                    ? "Play replay"
                    : "Start Jev"}
              </Button>
            )}
            {mode === "replay" ? (
              <>
                <input
                  aria-label="Game replay position"
                  type="range"
                  min="0"
                  max={trace.length}
                  value={index}
                  onChange={(e) => {
                    setPlaying(false);
                    setIndex(Number(e.target.value));
                  }}
                />
                <Button
                  secondary
                  aria-label="Next game move"
                  onClick={() => {
                    setPlaying(false);
                    setIndex((i) => Math.min(trace.length, i + 1));
                  }}
                >
                  <ChevronRight size={16} />
                </Button>
              </>
            ) : mode === "live" ? (
              <Button
                secondary
                disabled={busy || local.status !== "playing"}
                onClick={tick}
              >
                One move
              </Button>
            ) : null}
          </div>
          {mode === "manual" && (
            <div className="manual-controls">
              {Object.keys(options(local)).map((a) => (
                <Button
                  key={a}
                  secondary
                  disabled={local.status !== "playing"}
                  onClick={() => manual(a)}
                >
                  {a}
                </Button>
              ))}
            </div>
          )}
          {mode === "manual" && (
            <p className="fine">
              Focus the arena to use{" "}
              {game === "snake"
                ? "← / → to turn and ↑ to continue straight."
                : "arrow keys to move horizontally, W to rise, and S to descend."}
            </p>
          )}
          {error && <Notice error>{error}</Notice>}
          <div className="arcade-score-strip">
            <Stat label="Food or cores" value={String(state.score)} />
            <Stat label="Current decision" value={action?.action ?? "Ready"} />
            <Stat
              label="Request time"
              value={
                action?.latency_ms
                  ? `${Math.round(action.latency_ms)} ms`
                  : "No API call"
              }
            />
          </div>
        </div>
        <aside className="arcade-explanation">
          <Pane title="Inside the decision">
            <p>
              Game rules supply the immediate consequences of each move. Jev
              chooses one action. There is no hidden route planner.
            </p>
            <div className="action-probabilities">
              {probabilities.length ? (
                probabilities.map(([a, p]) => (
                  <div key={a}>
                    <span>{a}</span>
                    <div>
                      <motion.i animate={{ width: `${Number(p) * 100}%` }} />
                    </div>
                    <strong>{(Number(p) * 100).toFixed(1)}%</strong>
                  </div>
                ))
              ) : (
                <p className="fine">
                  {mode === "manual"
                    ? "You are choosing the moves; no model is being called."
                    : "Advance one move to inspect the action distribution."}
                </p>
              )}
            </div>
            <StateView
              title="What the model sees"
              value={observe(action?.state ?? state)}
            />
          </Pane>
          {mode === "replay" && (
            <Pane title="Same world, two controllers">
              <label>
                Controller
                <select
                  aria-label="Recorded game controller"
                  value={policy}
                  onChange={(e) => {
                    setPolicy(e.target.value);
                    setIndex(0);
                    setPlaying(false);
                  }}
                >
                  <option value="jev">Jev</option>
                  <option value="greedy">Greedy code baseline</option>
                </select>
              </label>
              <label>
                Playback speed
                <select
                  aria-label="Game playback speed"
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  <option value={700}>Slow</option>
                  <option value={350}>Normal</option>
                  <option value={120}>Fast</option>
                </select>
              </label>
              <p className="fine">
                Both controllers start from the same seeded world. Playback uses
                a fixed game clock. Request time is shown separately.
              </p>
              <div className="episode-results">
                {episodes.map((e: any) => (
                  <div key={e.id}>
                    <span>
                      {e.policy === "jev" ? "Jev" : "Greedy"} · seed {e.seed}
                    </span>
                    <strong>
                      {e.state.score}
                      {game === "snake"
                        ? ` food · ${e.state.status === "timeout" ? "90 turns" : e.state.status}`
                        : ` cores · ${e.state.status}`}
                    </strong>
                  </div>
                ))}
              </div>
            </Pane>
          )}
          <p className="fine">
            An original{" "}
            {game === "snake" ? "Snake environment" : "Three.js game"}, inspired
            by{" "}
            <a href="https://typesafe.ai/blog/introducing-system-one-models-and-jev">
              TypeSafe’s structured-state Doom demo
            </a>
            . These short seeded runs are demonstrations, not a general
            game-playing benchmark.
          </p>
        </aside>
      </div>
    </div>
  );
}
