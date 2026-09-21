import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type CSSProperties,
} from "react";
import { download, getApiKey, run } from "../../experience-prototypes/src/api";
import {
  createScene,
  paintLine,
  step,
  parseScene,
  ruleRequest,
  ruleFromAnswers,
  Revision,
  MATERIALS,
  PRESETS,
  WIDTH,
  HEIGHT,
  type Material,
  type Rule,
  type Scene,
} from "./engine";
import "./materials.css";
import protocolUrl from "./PROTOCOL.md?url&no-inline";
import labelsUrl from "./labels.v1.json?url&no-inline";

type Saved = { id: string; label: string; scene: Scene };
const COLORS = [
  "#f0ebdd",
  "#c59a4a",
  "#79abb3",
  "#78836f",
  "#ad7957",
  "#e47d4c",
  "#bbd5d0",
  "#a487bd",
];
const MOTIONS: {
  value: Rule["motion"];
  label: string;
  detail: string;
  icon: string;
}[] = [
  { value: "solid", label: "Stay", detail: "Solid · stays put", icon: "·" },
  {
    value: "powder",
    label: "Pile",
    detail: "Powder · falls and piles",
    icon: "⌄",
  },
  {
    value: "liquid",
    label: "Flow",
    detail: "Liquid · falls and spreads",
    icon: "≈",
  },
  { value: "gas", label: "Rise", detail: "Gas · rises and spreads", icon: "↑" },
];
function renderMatter(
  ctx: CanvasRenderingContext2D,
  s: Scene,
  width: number,
  height: number,
  dark: boolean,
) {
  const sx = width / s.width,
    sy = height / s.height;
  ctx.fillStyle = dark ? "#242d29" : COLORS[0];
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = dark ? "#46524a" : "#d9d3c4";
  for (let x = 4; x < s.width; x += 8)
    for (let y = 4; y < s.height; y += 8) {
      ctx.beginPath();
      ctx.arc(x * sx, y * sy, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  for (let i = 0; i < s.cells.length; i++) {
    const cell = s.cells[i];
    if (!cell) continue;
    const x = (i % s.width) * sx,
      y = Math.floor(i / s.width) * sy;
    ctx.fillStyle = COLORS[cell];
    if (cell === 1) {
      const size = 0.36 + ((i * 17) % 7) * 0.018;
      ctx.beginPath();
      ctx.ellipse(
        x + sx / 2,
        y + sy / 2,
        sx * size,
        sy * size,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else if (cell === 7) {
      ctx.beginPath();
      ctx.moveTo(x + sx / 2, y + 0.5);
      ctx.lineTo(x + sx - 0.5, y + sy / 2);
      ctx.lineTo(x + sx / 2, y + sy - 0.5);
      ctx.lineTo(x + 0.5, y + sy / 2);
      ctx.closePath();
      ctx.fill();
    } else if (cell === 6) {
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.ellipse(
        x + sx / 2,
        y + sy / 2,
        sx * 0.65,
        sy * 0.65,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (cell === 5) {
      ctx.beginPath();
      ctx.moveTo(x + sx / 2, y);
      ctx.quadraticCurveTo(x + sx * 1.3, y + sy, x + sx / 2, y + sy);
      ctx.quadraticCurveTo(x - sx * 0.2, y + sy, x + sx / 2, y);
      ctx.fill();
      ctx.fillStyle = "#f4ca75";
      ctx.fillRect(x + sx * 0.35, y + sy * 0.55, sx * 0.3, sy * 0.4);
    } else {
      ctx.fillRect(x, y, sx + 0.1, sy + 0.1);
      if (cell === 4) {
        ctx.fillStyle = "#805a4377";
        ctx.fillRect(x + 1, y + sy * (0.3 + (i % 3) * 0.15), sx - 2, 1);
      } else if (cell === 2 && s.cells[i - s.width] !== 2) {
        ctx.fillStyle = "#c6dfd4";
        ctx.fillRect(x, y, sx, 1);
      } else if (cell === 3 && s.cells[i - s.width] !== 3) {
        ctx.fillStyle = "#b1b8a0";
        ctx.fillRect(x, y, sx, 1);
      }
    }
  }
}
const STORE = "jev-material-scenes-v1";
export function MaterialsSandbox({
  compact = false,
}: { compact?: boolean } = {}) {
  const [expanded, setExpanded] = useState(!compact);
  const initial = useRef<Scene | null>(null);
  if (!initial.current) {
    const preset = new URLSearchParams(location.search).get("preset");
    initial.current = createScene(
      PRESETS.includes(preset as any)
        ? (preset as (typeof PRESETS)[number])
        : "terrarium",
    );
  }
  const [fullscreen, setFullscreen] = useState(false);
  const [mode, setMode] = useState<"paint" | "inspect">("paint"),
    [hovered, setHovered] = useState(false),
    [touching, setTouching] = useState(false),
    [hasPainted, setHasPainted] = useState(false),
    [inspected, setInspected] = useState(false);
  const zoom = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const update = () =>
      setFullscreen(document.fullscreenElement === workbench.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const workbench = useRef<HTMLElement>(null);
  const scene = useRef(initial.current),
    canvas = useRef<HTMLCanvasElement>(null),
    revision = useRef(new Revision()),
    abort = useRef<AbortController | null>(null),
    mounted = useRef(true),
    drawing = useRef<{ x: number; y: number } | null>(null);
  const [playing, setPlaying] = useState(
      () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    [brush, setBrush] = useState<Material>(1),
    [radius, setRadius] = useState(2),
    [version, setVersion] = useState(0),
    [cursor, setCursor] = useState({ x: 48, y: 20 });
  const [saved, setSaved] = useState<Saved[]>([]),
    [branches, setBranches] = useState<Saved[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(
      "Paint sand into the pool, or try the purple bloom dust.",
    ),
    [busy, setBusy] = useState(false),
    [proposal, setProposal] = useState<Rule | null>(null);
  const runRef = useRef(playing);
  runRef.current = playing;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const paintView = useRef({ brush, radius, mode, hovered, touching });
  paintView.current = { brush, radius, mode, hovered, touching };
  const bump = () => setVersion((v) => v + 1);
  function invalidate() {
    revision.current.next();
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setProposal(null);
  }
  function replace(next: Scene, text: string) {
    invalidate();
    drawing.current = null;
    setTouching(false);
    setInspected(false);
    setHasPainted(false);
    scene.current = structuredClone(next);
    setPlaying(false);
    setMessage(text);
    setError("");
    bump();
  }
  function updateRule(patch: Partial<Rule>) {
    invalidate();
    scene.current.rule = {
      ...scene.current.rule,
      ...patch,
      source: "manual",
      evidence: undefined,
    };
    bump();
  }
  function preserve(label = `Branch ${branches.length + 1}`) {
    invalidate();
    setBranches((all) =>
      [
        ...all,
        {
          id: crypto.randomUUID(),
          label: `${label} · tick ${scene.current.tick}`,
          scene: structuredClone(scene.current),
        },
      ].slice(-12),
    );
    setMessage("This branch is preserved. Keep painting, or restore it below.");
  }
  function save() {
    try {
      const next = [
        ...saved,
        {
          id: crypto.randomUUID(),
          label: `${scene.current.label} · tick ${scene.current.tick}`,
          scene: structuredClone(scene.current),
        },
      ].slice(-8);
      localStorage.setItem(STORE, JSON.stringify(next));
      setSaved(next);
      setMessage(
        "Saved in this browser. Export a scene JSON to keep a separate copy.",
      );
    } catch {
      setError(
        "Browser storage is unavailable or full. Export a scene JSON instead.",
      );
    }
  }
  async function importScene(file?: File) {
    if (!file) return;
    invalidate();
    const token = revision.current.value;
    try {
      if (file.size > 600_000)
        throw new Error("Scene files must be smaller than 600 KB.");
      const next = parseScene(JSON.parse(await file.text()));
      if (mounted.current && revision.current.valid(token))
        replace(next, "Scene imported and paused. Press Play when ready.");
    } catch (e) {
      if (mounted.current && revision.current.valid(token))
        setError(e instanceof Error ? e.message : "Could not open that scene.");
    }
  }
  async function interpret() {
    if (!getApiKey()) {
      setError(
        "Connect your Jev key in the page controls to interpret words. Every material control works locally without a key.",
      );
      return;
    }
    invalidate();
    const token = revision.current.value,
      instruction = scene.current.rule.instruction,
      request = ruleRequest(instruction),
      controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await run(
        request.state,
        request.questions,
        controller.signal,
      );
      if (
        !mounted.current ||
        !revision.current.valid(token) ||
        controller.signal.aborted
      )
        return;
      const rule = ruleFromAnswers(response.answers ?? {}, instruction);
      setProposal({ ...rule, evidence: { request, response } });
      setMessage(
        "Review the proposed controls, then apply them to the purple material.",
      );
    } catch (e) {
      if (
        mounted.current &&
        revision.current.valid(token) &&
        !controller.signal.aborted
      )
        setError(
          e instanceof Error
            ? e.message.split(getApiKey()).join("[redacted]").slice(0, 500)
            : "Interpretation failed. The current material is unchanged.",
        );
    } finally {
      if (mounted.current && revision.current.valid(token)) {
        setBusy(false);
        abort.current = null;
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    try {
      const stored = JSON.parse(localStorage.getItem(STORE) ?? "[]");
      if (!Array.isArray(stored) || stored.length > 8) throw new Error();
      setSaved(
        stored.map((v) => {
          if (typeof v.id !== "string" || typeof v.label !== "string")
            throw new Error();
          return {
            id: v.id,
            label: v.label.slice(0, 100),
            scene: parseScene(v.scene),
          };
        }),
      );
    } catch {
      setError(
        "Previously saved scenes could not be read. Your current scene still works.",
      );
    }
    let raf = 0,
      previous = 0,
      lastPublish = 0,
      accumulator = 0;
    function frame(now: number) {
      const delta = previous ? Math.min(80, now - previous) : 0;
      previous = now;
      if (runRef.current && !document.hidden) {
        accumulator += delta;
        while (accumulator >= 40) {
          step(scene.current);
          accumulator -= 40;
        }
      } else accumulator = 0;
      const el = canvas.current,
        ctx = el?.getContext("2d");
      if (ctx && el) {
        const s = scene.current,
          sx = el.width / s.width,
          sy = el.height / s.height,
          view = paintView.current,
          c = cursorRef.current;
        const dark = document.documentElement.dataset.theme === "dark";
        renderMatter(ctx, s, el.width, el.height, dark);
        if (view.hovered || view.touching || document.activeElement === el) {
          ctx.strokeStyle = dark ? "#f3edcf" : "#374e3e";
          ctx.lineWidth = 1.5;
          if (view.mode === "paint") {
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.ellipse(
              (c.x + 0.5) * sx,
              (c.y + 0.5) * sy,
              (view.radius + 0.55) * sx,
              (view.radius + 0.55) * sy,
              0,
              0,
              Math.PI * 2,
            );
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = COLORS[view.brush];
            ctx.globalAlpha = 0.45;
            ctx.beginPath();
            ctx.arc((c.x + 0.5) * sx, (c.y + 0.5) * sy, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          } else ctx.strokeRect(c.x * sx - 1, c.y * sy - 1, sx + 2, sy + 2);
        }
        const detail = zoom.current?.getContext("2d");
        if (view.touching && detail) {
          detail.imageSmoothingEnabled = false;
          detail.clearRect(0, 0, 96, 96);
          detail.drawImage(
            el,
            Math.max(0, Math.min(el.width - 80, (c.x + 0.5) * sx - 40)),
            Math.max(0, Math.min(el.height - 80, (c.y + 0.5) * sy - 40)),
            80,
            80,
            0,
            0,
            96,
            96,
          );
        }
      }
      if (now - lastPublish > 300) {
        lastPublish = now;
        bump();
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => {
      if (reduced.matches) setPlaying(false);
    };
    reduced.addEventListener("change", change);
    return () => {
      mounted.current = false;
      revision.current.next();
      abort.current?.abort();
      cancelAnimationFrame(raf);
      reduced.removeEventListener("change", change);
    };
  }, []);
  function point(e: PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          WIDTH - 1,
          Math.floor(((e.clientX - rect.left) / rect.width) * WIDTH),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          HEIGHT - 1,
          Math.floor(((e.clientY - rect.top) / rect.height) * HEIGHT),
        ),
      ),
    };
  }
  function draw(p: { x: number; y: number }) {
    setHasPainted(true);
    invalidate();
    paintLine(scene.current, drawing.current ?? p, p, brush, radius);
    drawing.current = p;
    setCursor(p);
    bump();
  }
  void version;
  const current = scene.current,
    rule = current.rule;
  const palette = [
    { id: 0, name: "Erase", description: "Remove cells" },
    ...MATERIALS,
    {
      id: 7,
      name: rule.name || "Your material",
      description: "A material with your own rule",
    },
  ];
  const selectedMaterial = palette.find((m) => m.id === brush)!;
  const cell = current.cells[cursor.y * WIDTH + cursor.x] as Material,
    observedMaterial = palette.find((m) => m.id === cell)!;
  const brushDescription =
    brush === 7
      ? MOTIONS.find((m) => m.value === rule.motion)!.detail
      : selectedMaterial.description;
  function selectMaterial(id: Material) {
    setBrush(id);
    setMode("paint");
    setInspected(false);
  }
  function motionControls() {
    return (
      <div
        className="mat-motions"
        role="group"
        aria-label="Custom material movement"
      >
        {MOTIONS.map((m) => (
          <button
            key={m.value}
            aria-pressed={rule.motion === m.value}
            title={m.detail}
            onClick={() => updateRule({ motion: m.value })}
          >
            <span aria-hidden="true">{m.icon}</span>
            {m.label}
          </button>
        ))}
      </div>
    );
  }
  function inspectPoint(p: { x: number; y: number }) {
    setCursor(p);
    setInspected(true);
    setPlaying(false);
  }
  return (
    <div
      className={`materials-lab ${compact ? "is-compact" : ""} ${expanded ? "show-details" : ""}`}
    >
      <header className="mat-intro">
        <div>
          <span className="mat-eyebrow">A small world made by hand</span>
          <h2>Pour sand into the pool.</h2>
          <p>
            Pick a material and draw. Inspect a cell to see the rule behind it.
          </p>
        </div>
        <span className="mat-local">Local simulation · 96 × 64 cells</span>
      </header>
      {compact && (
        <button
          className="mat-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? "Hide material controls and saved scenes"
            : "Material controls, branches and export"}
        </button>
      )}
      <div className="mat-layout">
        <section
          ref={workbench}
          className="mat-workbench"
          aria-label="Material canvas and tools"
        >
          <div className="mat-toolbar">
            <div
              className="mat-mode-switch"
              role="group"
              aria-label="Canvas tool"
            >
              <button
                aria-pressed={mode === "paint"}
                onClick={() => {
                  setMode("paint");
                  setInspected(false);
                }}
              >
                Paint
              </button>
              <button
                aria-pressed={mode === "inspect"}
                onClick={() => {
                  setMode("inspect");
                  setPlaying(false);
                  setInspected(false);
                }}
              >
                Inspect
              </button>
            </div>
            <div className="mat-playback">
              <button
                className="mat-primary"
                onClick={() => setPlaying(!playing)}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <button
                onClick={() => {
                  preserve("Before reset");
                  replace(
                    createScene(),
                    "Reset to the terrarium. Your old scene is preserved below.",
                  );
                }}
              >
                Reset
              </button>
              <button
                className="mat-fullscreen"
                onClick={async () => {
                  try {
                    if (document.fullscreenElement)
                      await document.exitFullscreen();
                    else if (workbench.current?.requestFullscreen)
                      await workbench.current.requestFullscreen();
                    else
                      setError(
                        "Fullscreen is unavailable in this browser. Open the full sandbox for a larger canvas.",
                      );
                  } catch {
                    setError(
                      "Fullscreen could not open. Your scene is preserved.",
                    );
                  }
                }}
                aria-label="Toggle canvas fullscreen"
                aria-pressed={fullscreen}
              >
                <span aria-hidden="true">{fullscreen ? "↙" : "↗"}</span>
                <span>{fullscreen ? "Exit" : "Expand"}</span>
              </button>
            </div>
          </div>
          <div
            className="mat-palette"
            role="group"
            aria-label="Painting material"
          >
            {palette.map((m) => (
              <button
                key={m.id}
                aria-pressed={brush === m.id && mode === "paint"}
                title={`${m.id}: ${m.description}`}
                onClick={() => selectMaterial(m.id as Material)}
              >
                <i
                  className={`mat-swatch mat-swatch-${m.id}`}
                  style={{ background: COLORS[m.id] }}
                />
                <span>{m.name}</span>
                <kbd>{m.id}</kbd>
              </button>
            ))}
          </div>
          <div className="mat-brush">
            <div className="mat-selected">
              <strong>
                {mode === "inspect" ? "Inspect a cell" : selectedMaterial.name}
              </strong>
              <span>
                {mode === "inspect"
                  ? "Tap the world. The scene pauses while you look."
                  : brushDescription}
              </span>
            </div>
            <label>
              <span className="mat-brush-label">Size</span>
              <input
                aria-label="Brush radius"
                type="range"
                min="0"
                max="7"
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
              />
              <span
                className="mat-size-preview"
                style={
                  {
                    "--brush-size": `${Math.max(4, radius * 2 + 4)}px`,
                  } as CSSProperties
                }
                aria-hidden="true"
              />
              <output>{radius * 2 + 1}</output>
            </label>
          </div>
          {compact && brush === 7 && mode === "paint" && (
            <div className="mat-quick-rule">
              <div>
                <span className="mat-eyebrow">
                  Your material moves this way
                </span>
                <button
                  className="mat-text-button"
                  onClick={() => setExpanded(!expanded)}
                  aria-expanded={expanded}
                >
                  {expanded ? "Close rule editor" : "Edit reaction ↗"}
                </button>
              </div>
              {motionControls()}
              <p>
                {rule.contact === "none"
                  ? "No contact reaction."
                  : `Touches ${rule.contact} → becomes ${rule.becomes}.`}{" "}
                <span>Changes every purple cell immediately.</span>
              </p>
            </div>
          )}
          <div
            className={`mat-stage ${mode === "inspect" ? "is-inspecting" : ""}`}
          >
            <canvas
              ref={canvas}
              width={768}
              height={512}
              tabIndex={0}
              role="application"
              aria-label="Material painting canvas. Arrow keys move the cursor; Space or Enter paints or inspects; number keys 0 to 7 choose material. Pointer and touch drag to paint."
              aria-describedby="mat-keyboard"
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.focus({ preventScroll: true });
                e.currentTarget.setPointerCapture(e.pointerId);
                setHovered(true);
                setTouching(e.pointerType === "touch");
                const p = point(e);
                if (mode === "inspect") inspectPoint(p);
                else draw(p);
              }}
              onPointerMove={(e) => {
                if (mode === "paint" || !inspected) setCursor(point(e));
                if (drawing.current && mode === "paint") draw(point(e));
              }}
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => {
                if (!drawing.current) setHovered(false);
              }}
              onPointerUp={() => {
                drawing.current = null;
                setTouching(false);
              }}
              onPointerCancel={() => {
                drawing.current = null;
                setTouching(false);
              }}
              onLostPointerCapture={() => {
                drawing.current = null;
                setTouching(false);
              }}
              onKeyDown={(e) => {
                const moves: Record<string, [number, number]> = {
                  ArrowLeft: [-1, 0],
                  ArrowRight: [1, 0],
                  ArrowUp: [0, -1],
                  ArrowDown: [0, 1],
                };
                if (moves[e.key]) {
                  e.preventDefault();
                  const [dx, dy] = moves[e.key];
                  setCursor((c) => ({
                    x: Math.min(
                      WIDTH - 1,
                      Math.max(0, c.x + dx * (e.shiftKey ? 5 : 1)),
                    ),
                    y: Math.min(
                      HEIGHT - 1,
                      Math.max(0, c.y + dy * (e.shiftKey ? 5 : 1)),
                    ),
                  }));
                } else if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  if (mode === "inspect") inspectPoint(cursor);
                  else {
                    draw(cursor);
                    drawing.current = null;
                  }
                } else if (/^[0-7]$/.test(e.key))
                  selectMaterial(Number(e.key) as Material);
                else if (e.key === "Escape") {
                  setInspected(false);
                  setMode("paint");
                }
              }}
            />
            {!hasPainted && mode === "paint" && (
              <div className="mat-canvas-invitation" aria-hidden="true">
                <span>
                  {
                    [
                      "Make room for something new.",
                      "Leave a little sand here.",
                      "Pour water over the ledge.",
                      "Draw a wall. Make a dam.",
                      "Plant some wood. Then try fire.",
                      "Touch fire to the wooden ledge.",
                      "Let a little steam rise.",
                      "Give your material a place to grow.",
                    ][brush]
                  }
                </span>
                <svg width="28" height="45" viewBox="0 0 28 45">
                  <path d="M4 2C24 7 24 22 16 38M9 31l7 8 9-7" />
                </svg>
              </div>
            )}
            {mode === "inspect" && inspected && (
              <div
                className="mat-cell-card"
                role="region"
                aria-label="Cell inspection"
              >
                <div>
                  <i style={{ background: COLORS[cell] }} />
                  <strong>
                    {cell === 0 ? "Empty space" : observedMaterial.name}
                  </strong>
                  <button
                    onClick={() => setInspected(false)}
                    aria-label="Close cell inspection"
                  >
                    ×
                  </button>
                </div>
                <span className="mat-cell-coordinate" aria-live="polite">
                  Cell {cursor.x + 1}, {cursor.y + 1} · tick {current.tick}
                </span>
                <p>
                  {cell === 0
                    ? "Room for a new material."
                    : cell === 7
                      ? `${MOTIONS.find((m) => m.value === rule.motion)!.detail}. ${rule.contact === "none" ? "No contact reaction." : `Touches ${rule.contact} → becomes ${rule.becomes}.`}`
                      : observedMaterial.description + "."}
                </p>
                <button onClick={() => selectMaterial(cell)}>
                  {cell === 0 ? "Use eraser" : "Paint with this"}
                </button>
              </div>
            )}
            {touching && mode === "paint" && (
              <div
                className="mat-touch-preview"
                style={{
                  left: `${Math.max(17, Math.min(83, ((cursor.x + 0.5) / WIDTH) * 100))}%`,
                  top: `clamp(108px, calc(${(cursor.y / HEIGHT) * 100}% - 24px), calc(100% - 18px))`,
                }}
                aria-hidden="true"
              >
                <canvas ref={zoom} width={96} height={96} />
                <span>{selectedMaterial.name}</span>
              </div>
            )}
            <span className="mat-sr-only" role="status">
              Cursor {cursor.x + 1}, {cursor.y + 1}.{" "}
              {cell === 0 ? "Empty space" : observedMaterial.name}.
            </span>
            <div className="mat-stage-meta" aria-hidden="true">
              <span>
                {current.label} / {playing ? "running" : "paused"}
              </span>
              <span>
                {cursor.x + 1} : {cursor.y + 1}
              </span>
            </div>
          </div>
          <div className="mat-scene-tools">
            <p className="mat-hint" id="mat-keyboard">
              Drag to paint.{" "}
              <span>
                Arrows move · Space paints · 0–7 choose · Shift moves five
                cells.
              </span>
            </p>
            <details>
              <summary>Scene tools</summary>
              <div>
                <button
                  onClick={() => {
                    setPlaying(false);
                    step(current);
                    bump();
                  }}
                >
                  One step
                </button>
                <button onClick={() => preserve()}>Preserve branch</button>
                <span>Tick {current.tick}</span>
              </div>
            </details>
          </div>
        </section>
        <aside className="mat-inspector">
          <span className="mat-eyebrow">One material you can rewrite</span>
          <h3>
            <i style={{ background: COLORS[7] }} />
            {rule.name || "Your material"}
          </h3>
          <label>
            Name
            <input
              maxLength={50}
              value={rule.name}
              onChange={(e) => updateRule({ name: e.target.value })}
            />
          </label>
          <div className="mat-movement">
            <span className="mat-control-label">Movement</span>
            {motionControls()}
            <p>{MOTIONS.find((m) => m.value === rule.motion)!.detail}</p>
          </div>
          <div className="mat-rule-row">
            <label>
              When it touches
              <select
                value={rule.contact}
                onChange={(e) =>
                  updateRule({ contact: e.target.value as Rule["contact"] })
                }
              >
                {["none", "water", "fire", "sand", "wood"].map((v) => (
                  <option key={v} value={v}>
                    {v === "none" ? "Nothing · no reaction" : v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              It becomes
              <select
                disabled={rule.contact === "none"}
                value={rule.becomes}
                onChange={(e) =>
                  updateRule({ becomes: e.target.value as Rule["becomes"] })
                }
              >
                {MATERIALS.map((m) => (
                  <option key={m.id} value={m.name.toLowerCase()}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mat-hint">
            Controls apply immediately to every purple cell. Only that cell
            transforms. Its neighbor stays unchanged.
          </p>
          <details>
            <summary>Describe a rule to Jev</summary>
            <label>
              Your instruction
              <textarea
                rows={3}
                maxLength={600}
                value={rule.instruction}
                onChange={(e) => updateRule({ instruction: e.target.value })}
              />
            </label>
            <button
              disabled={busy || !rule.instruction.trim()}
              onClick={interpret}
            >
              {busy ? "Interpreting…" : "Propose typed controls"}
            </button>
            {busy && <button onClick={invalidate}>Cancel</button>}
            <p className="mat-hint">
              Uses your connected key. Jev chooses controls; code simulates
              their effect. Interpretation accuracy has not been measured.
            </p>
          </details>
          {proposal && (
            <div className="mat-proposal">
              <strong>Proposed rule</strong>
              <p>
                {proposal.motion};{" "}
                {proposal.contact === "none"
                  ? "no reaction"
                  : `${proposal.contact} contact → ${proposal.becomes}`}
                .
              </p>
              <button
                onClick={() => {
                  const next = proposal;
                  invalidate();
                  scene.current.rule = next;
                  setBrush(7);
                  setMessage(
                    "Applied the Jev proposal. Paint purple cells to try it.",
                  );
                  bump();
                }}
              >
                Apply proposal
              </button>
              <details>
                <summary>Inspect actual request and reply</summary>
                <pre>{JSON.stringify(proposal.evidence, null, 2)}</pre>
              </details>
            </div>
          )}
          <div className="mat-presets">
            <span className="mat-eyebrow">A fresh starting point</span>
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  preserve("Before preset");
                  replace(createScene(p), `Opened ${p}. Press Play to begin.`);
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </aside>
      </div>
      {error && (
        <p className="mat-error" role="alert">
          {error}
        </p>
      )}
      <p className="mat-status" role="status">
        {message}
      </p>
      <section className="mat-artifacts">
        <div>
          <h3>Keep a world. Try another.</h3>
          <p>
            Branches stay in this tab. Saved scenes stay in this browser.
            Exported JSON includes your custom instruction.
          </p>
        </div>
        <div className="mat-artifact-actions">
          <button onClick={save}>Save scene</button>
          <button onClick={() => download("jev-material-scene.json", current)}>
            Export JSON
          </button>
          <label className="mat-import">
            Import JSON
            <input
              aria-label="Import material scene JSON"
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                void importScene(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {branches.length > 0 && (
          <div className="mat-scene-list">
            <strong>Branches</strong>
            {branches.map((b) => (
              <button
                key={b.id}
                onClick={() => replace(b.scene, `Restored ${b.label}.`)}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
        {saved.length > 0 && (
          <div className="mat-scene-list">
            <strong>Saved scenes</strong>
            {saved.map((s) => (
              <button
                key={s.id}
                onClick={() => replace(s.scene, `Loaded ${s.label}.`)}
              >
                {s.label}
              </button>
            ))}
            <button
              onClick={() => {
                try {
                  localStorage.removeItem(STORE);
                  setSaved([]);
                  setMessage(
                    "Saved scenes removed from this browser. Your current canvas is preserved.",
                  );
                } catch {
                  setError("Could not access browser storage.");
                }
              }}
            >
              Clear saved scenes
            </button>
          </div>
        )}
        <p className="mat-hint">
          Share a built-in starting scene:{" "}
          {PRESETS.map((p) => (
            <a key={p} href={`/materials?preset=${p}`}>
              {p}
            </a>
          ))}
          . These links contain no painted scene or private instruction.
        </p>
      </section>
      <details className="mat-evidence">
        <summary>How this sandbox works</summary>
        <p>
          Six built-in materials and one typed rule run locally at 25 simulation
          steps per second. Fire burns wood; water touching fire becomes steam;
          steam slowly disappears. These are designed mechanics, not physical
          predictions. The same exported state produces the same future when
          stepped without edits.
        </p>
        <p>
          Instruction labels were frozen before model results. No model
          evaluation has been recorded yet. Manual controls and painted scenes
          are independent of Jev availability.
        </p>
        <p>
          <a href={protocolUrl} download="jev-materials-protocol.md">
            Download the instruction evaluation protocol
          </a>
          {" · "}
          <a href={labelsUrl} download="jev-materials-labels-v1.json">
            Download the frozen labels
          </a>
        </p>
        <p>
          Current purple rule source:{" "}
          {rule.source === "jev"
            ? "Accepted live Jev proposal"
            : "Manual controls"}
          . Editing, importing, resetting and branching cancel pending requests.
        </p>
      </details>
    </div>
  );
}
