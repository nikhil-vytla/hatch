import { memo, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowDownToLine, ArrowRight, Check, ChevronDown, Eraser, GitBranch, LoaderCircle, Pause, Play, Redo2, Sparkles, Undo2, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { download, getApiKey, run } from "./api";
import { ENGINE_VERSION, HEIGHT, RECIPES, WIDTH, exportSvg, fitStroke, marks, point, recipe, sampleStroke, type Stroke } from "../../live-worlds/ghost-brush/engine";
import { PROTOCOL, fingerprint, lexicalRank, parseRanking, requestFor } from "../../live-worlds/ghost-brush/model";
import { initialSession, reduce, type Token } from "../../live-worlds/ghost-brush/session";
import recorded from "../../live-worlds/ghost-brush/examples.json";
import "./ghost-brush.css";

const StrokePaths = memo(function StrokePaths({ stroke, overrideId }: { stroke: Stroke; overrideId?: string }) {
  const paths = useMemo(() => marks(stroke, overrideId), [stroke, overrideId]);
  return <g>{paths.map((p, i) => <path key={i} d={p.d} fill={p.fill} stroke={p.stroke} strokeWidth={p.width} opacity={p.opacity} strokeLinecap="round" strokeLinejoin="round" />)}</g>;
});
function Sample({ stroke, id, animate = false }: { stroke: Stroke; id: string; animate?: boolean }) {
  return <svg viewBox="0 70 1000 500" aria-hidden="true" className={animate ? "gb-sample animated" : "gb-sample"}>{animate && <g opacity=".7"><StrokePaths stroke={stroke} overrideId={id} /></g>}<g className="gb-ink-reveal"><StrokePaths stroke={stroke} overrideId={id} /></g></svg>;
}
type RecordedExample = { id: string; prompt: string; request: ReturnType<typeof requestFor>; response: unknown; finishedAt: string; requestSha256: string; responseSha256: string };
const EXAMPLES = recorded.rows as unknown as RecordedExample[];
const PHRASES = ["A quiet fabric made of blue threads", "Wind through the sea grass", "Strange branching violet coral", "Golden dust floating in sunlight"];
export function GhostBrush(_props: { result?: unknown } = {}) {
  const [session, dispatch] = useReducer(reduce, undefined, initialSession);
  const [prompt, setPrompt] = useState(PHRASES[0]);
  const [compare, setCompare] = useState(false), [rightId, setRightId] = useState("coastal-wind");
  const [motionOn, setMotionOn] = useState(true), [variantName, setVariantName] = useState("");
  const [compareStroke, setCompareStroke] = useState<number | null>(null);
  const [keyboardPen, setKeyboardPen] = useState({ x: 360, y: 300, down: false, visible: false });
  const [keyError, setKeyError] = useState("");
  const reducedMotion = useReducedMotion(), svgRef = useRef<SVGSVGElement>(null), serial = useRef(0);
  const inFlight = useRef<{ token: Token; controller: AbortController } | null>(null);
  const visibleStrokes = session.strokes.slice(0, session.cursor);
  const lastStroke = visibleStrokes.find(s => s.id === compareStroke) ?? visibleStrokes.at(-1);
  const demo = useMemo(() => sampleStroke(), []);
  const compared = useMemo(() => lastStroke ? fitStroke(lastStroke) : demo, [lastStroke, demo]);
  const current = recipe(session.brushId), queued = session.queued && recipe(session.queued.id);
  const latest = session.receipts.at(-1), latestRanking = latest?.ranking;
  const activeReceipt = [...session.receipts].reverse().find(r => r.token.id === session.brushReceiptId);
  const ordered = useMemo(() => latestRanking ? latestRanking.map(s => recipe(s.id)) : [...RECIPES], [latestRanking]);

  useEffect(() => {
    const pending = inFlight.current;
    if (pending && (pending.token.revision !== session.revision || pending.token.epoch !== session.epoch)) { pending.controller.abort(); inFlight.current = null; }
  }, [session.revision, session.epoch]);
  useEffect(() => () => inFlight.current?.controller.abort(), []);
  useEffect(() => { if (!session.active) setKeyboardPen(p => p.down ? { ...p, down: false } : p); }, [session.active]);

  function changePrompt(value: string) { setPrompt(value); setKeyError(""); dispatch({ type: "edit" }); }
  async function interpret(source: "lexical" | "jev") {
    if (!prompt.trim()) { setKeyError("Write a style phrase first."); return; }
    if (source === "jev" && !getApiKey()) { setKeyError("Connect your Jev key using the app's key control, then try again. Local preview is ready now."); return; }
    setKeyError(""); inFlight.current?.controller.abort();
    const token = { id: ++serial.current, epoch: session.epoch, revision: session.revision + 1 }, request = requestFor(prompt);
    dispatch({ type: "request", token, source, request });
    if (source === "lexical") { dispatch({ type: "resolve", token, ranking: lexicalRank(prompt), response: { algorithm: "Exact token or tag-prefix matches; count matches; bank order breaks ties.", modelCalled: false } }); return; }
    const controller = new AbortController(); inFlight.current = { token, controller };
    try { const response = await run(request.state, request.questions, controller.signal); dispatch({ type: "resolve", token, ranking: parseRanking(response), response }); }
    catch (error) { dispatch({ type: "fail", token, error: error instanceof Error && error.name === "AbortError" ? "Request cancelled. The current brush is unchanged." : error instanceof Error ? error.message : "Jev could not complete this request. The current brush is unchanged." }); }
    finally { if (inFlight.current?.token.id === token.id) inFlight.current = null; }
  }
  function loadExample(example: RecordedExample) {
    inFlight.current?.controller.abort(); setPrompt(example.prompt); setKeyError("");
    const token = { id: ++serial.current, epoch: session.epoch, revision: session.revision + 1 };
    if (JSON.stringify(example.request.state.candidates) !== JSON.stringify(RECIPES)) { setKeyError("This recording belongs to a different recipe bank."); return; }
    dispatch({ type: "request", token, source: "recorded", request: example.request });
    dispatch({ type: "resolve", token, ranking: parseRanking(example.response), response: { recordedAt: example.finishedAt, requestSha256: example.requestSha256, responseSha256: example.responseSha256, response: example.response } });
  }
  function pointerPoint(e: Pick<PointerEvent<SVGSVGElement>, "clientX" | "clientY" | "pressure" | "pointerType">) {
    const rect = svgRef.current!.getBoundingClientRect();
    return point((e.clientX - rect.left) / rect.width * WIDTH, (e.clientY - rect.top) / rect.height * HEIGHT, e.pointerType === "pen" ? e.pressure : .55);
  }
  function pointerDown(e: PointerEvent<SVGSVGElement>) { if (e.button !== 0 || !e.isPrimary) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); setKeyboardPen(p => ({ ...p, visible: false, down: false })); dispatch({ type: "begin", point: pointerPoint(e) }); }
  function pointerMove(e: PointerEvent<SVGSVGElement>) { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; dispatch({ type: "move", point: pointerPoint(e) }); }
  function endPointer(e: PointerEvent<SVGSVGElement>) { if (e.currentTarget.hasPointerCapture(e.pointerId)) { dispatch({ type: "end" }); e.currentTarget.releasePointerCapture(e.pointerId); } }
  function keyDraw(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === " ") { e.preventDefault(); if (e.repeat) return; if (keyboardPen.down) dispatch({ type: "end" }); else dispatch({ type: "begin", point: point(keyboardPen.x, keyboardPen.y) }); setKeyboardPen(p => ({ ...p, down: !p.down, visible: true })); }
    else if (e.key.startsWith("Arrow")) { e.preventDefault(); const step = e.shiftKey ? 25 : 9, p = point(keyboardPen.x + (e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0), keyboardPen.y + (e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0)); setKeyboardPen(old => ({ ...old, ...p, visible: true })); if (keyboardPen.down) dispatch({ type: "move", point: p }); }
    else if (e.key === "Escape") { dispatch({ type: "end" }); setKeyboardPen(p => ({ ...p, down: false })); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); dispatch({ type: "rewind", cursor: session.cursor + (e.shiftKey ? 1 : -1) }); }
  }
  function drawExample() {
    dispatch({ type: "begin", point: demo.points[0] });
    for (const p of demo.points.slice(1)) dispatch({ type: "move", point: p });
    dispatch({ type: "end" });
  }
  async function evidence() { const bankSha256 = await fingerprint(RECIPES); download("ghost-brush-evidence.json", { format: "ghost-brush-session/v1", bankSha256, engine: ENGINE_VERSION, protocol: PROTOCOL, canvas: { width: WIDTH, height: HEIGHT }, prompt, recipes: RECIPES, session, note: "Text-based recipe selection. No drawing pixels or path were sent to Jev. Lexical results are local code, not model judgments. SVG artwork is deterministic from saved strokes and this engine version." }); }
  const busy = !!session.request;
  return <section className="ghost-brush" aria-label="Ghost Brush drawing instrument">
    <div className="gb-intro"><div><span className="gb-eyebrow">A small instrument for making marks</span><h2>Ghost Brush<span>.</span></h2><p>Draw a line. Give it a character. Keep the versions you like.</p></div><div className="gb-live-label"><span /> Drawing runs locally</div></div>
    <div className="gb-workspace">
      <div className="gb-paper-column">
        <div className="gb-paper-top"><div><span className="gb-swatch" style={{ background: current.ink }} /><strong>{current.name}</strong><span className="gb-source">{queued ? `Next: ${queued.name}` : session.active ? "Stroke in progress" : activeReceipt?.source === "recorded" ? "Recorded Jev example" : activeReceipt?.source === "jev" ? "Jev description fit" : activeReceipt?.source === "lexical" ? "Local tag match" : "Chosen by hand"}</span></div><span className="gb-counter">{session.cursor.toString().padStart(2, "0")} strokes</span></div>
        <div className="gb-paper">
          <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="gb-drawing" tabIndex={0} role="application" aria-label="Drawing sheet. Drag to draw. Keyboard: arrows move the pen, Space toggles drawing, Escape lifts, Control or Command Z undoes." onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={() => dispatch({ type: "end" })} onKeyDown={keyDraw} onBlur={() => { if (keyboardPen.down) dispatch({ type: "end" }); }}>
            <title>Ghost Brush artwork</title>
            {visibleStrokes.map(s => <StrokePaths key={s.id} stroke={s} />)}
            {session.active && <StrokePaths stroke={session.active} />}
            {keyboardPen.visible && <g className="gb-keyboard-cursor" transform={`translate(${keyboardPen.x} ${keyboardPen.y})`}><path d="M-8 0H8M0-8V8" stroke={current.ink} strokeWidth="2" /><circle r="12" fill="none" stroke={current.ink} strokeDasharray={keyboardPen.down ? undefined : "3 3"} /></g>}
          </svg>
          {!session.cursor && !session.active && <div className="gb-paper-invitation" aria-hidden="true"><span>Make a mark</span><p>A loop, a scribble, a wandering line.</p><div className="gb-invitation-line"><Sample stroke={demo} id={session.brushId} /></div></div>}
          <div className="gb-paper-caption">ORIGINAL PROCEDURAL INK <span>{WIDTH} × {HEIGHT}</span></div>
        </div>
        <div className="gb-tools">
          <div><button title="Undo stroke" aria-label="Undo stroke" disabled={!session.cursor || !!session.active} onClick={() => dispatch({ type: "rewind", cursor: session.cursor - 1 })}><Undo2 size={17} /></button><button title="Redo stroke" aria-label="Redo stroke" disabled={session.cursor >= session.strokes.length || !!session.active} onClick={() => dispatch({ type: "rewind", cursor: session.cursor + 1 })}><Redo2 size={17} /></button><button onClick={drawExample} disabled={!!session.active || session.cursor >= 80}>Draw a sample</button><button onClick={() => dispatch({ type: "clear" })} disabled={!session.strokes.length || !!session.active}><Eraser size={15} /> Fresh sheet</button></div>
          <button className={compare ? "gb-active" : ""} onClick={() => setCompare(!compare)}><GitBranch size={15} /> Compare one stroke</button>
        </div>
        <div className="gb-status" role="status" aria-live="polite">{busy && <LoaderCircle className="spin" size={14} />}{keyError || session.notice}</div>
        {compare && <motion.div className="gb-compare" initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}><div className="gb-section-title"><div><strong>One gesture. Two materials.</strong><span>Same seed and path, fitted identically to both previews.</span></div><button aria-label="Close comparison" onClick={() => setCompare(false)}><X size={16} /></button></div><div className="gb-compare-controls"><label>Gesture<select value={lastStroke?.id ?? "sample"} onChange={e => setCompareStroke(Number(e.target.value))}>{!visibleStrokes.length && <option value="sample">Built-in sample</option>}{visibleStrokes.map((s, i) => <option key={s.id} value={s.id}>Stroke {i + 1} · {recipe(s.recipeId).name}</option>)}</select></label><label>Compare with<select value={rightId} onChange={e => setRightId(e.target.value)}>{RECIPES.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label></div><div className="gb-comparison-pair"><div><Sample stroke={compared} id={session.brushId} /><strong>{current.name}</strong></div><div><Sample stroke={compared} id={rightId} /><strong>{recipe(rightId).name}</strong><button onClick={() => dispatch({ type: "select", id: rightId })}>Use for next stroke <ArrowRight size={14} /></button></div></div><p>Comparison never repaints your sheet. Each finished stroke keeps its original recipe.</p></motion.div>}
        <details className="gb-history"><summary><span><GitBranch size={15} /> History & preserved variants</span><span>{session.variants.length} saved <ChevronDown size={14} /></span></summary><div className="gb-history-body"><label>Rewind to stroke {session.cursor} of {session.strokes.length}<input type="range" min="0" max={session.strokes.length || 1} value={session.cursor} disabled={!session.strokes.length || !!session.active} onChange={e => dispatch({ type: "rewind", cursor: Number(e.target.value) })} /></label><p>Drawing from an earlier point saves the old future. Restoring or clearing also preserves your current sheet. Variants live in this tab; export evidence before reloading.</p><div className="gb-save"><input aria-label="Variant name" placeholder="Name this version" value={variantName} onChange={e => setVariantName(e.target.value)} /><button disabled={!session.cursor || !!session.active} onClick={() => { dispatch({ type: "save", name: variantName }); setVariantName(""); }}>Preserve</button></div><div className="gb-variants">{session.variants.map(v => <button key={v.id} onClick={() => dispatch({ type: "restore", id: v.id })} disabled={!!session.active}><span>{v.name}</span><small>{v.cursor} strokes · restore</small></button>)}</div></div></details>
        <div className="gb-export"><button disabled={!session.cursor} onClick={() => download("ghost-brush.svg", exportSvg(visibleStrokes, `Ghost Brush · ${prompt}`), "image/svg+xml")}><ArrowDownToLine size={15} /> Artwork SVG</button><button onClick={() => void evidence()}><ArrowDownToLine size={15} /> Stroke & decision evidence</button></div>
      </div>
      <aside className="gb-studio">
        <div className="gb-prompt-box"><label htmlFor="gb-intent">What should the line feel like?</label><textarea id="gb-intent" value={prompt} maxLength={1200} onChange={e => changePrompt(e.target.value)} rows={3} /><div className="gb-prompt-chips">{PHRASES.slice(1).map((phrase, i) => <button key={phrase} onClick={() => changePrompt(phrase)}>{["Windblown", "Branching", "Golden dust"][i]}</button>)}</div><div className="gb-prompt-actions"><button onClick={() => void interpret("lexical")} disabled={!prompt.trim()}>Local preview</button><button className="gb-primary" onClick={() => void interpret("jev")} disabled={!prompt.trim() || busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />} Ask Jev</button>{busy && <button aria-label="Cancel Jev request" onClick={() => dispatch({ type: "cancel" })}><X size={15} /></button>}</div><p>Local preview counts matching tags. Jev reads all 10 recipe descriptions using your key. Neither sees the drawing. Changes wait until you lift the pen.</p>{EXAMPLES.length > 0 && <div className="gb-recorded"><span>Try a recorded Jev decision</span><div>{EXAMPLES.map(e => <button key={e.id} onClick={() => loadExample(e)}>{e.id === "quiet-fabric" ? "Blue fabric" : "Violet coral"}<ArrowRight size={12} /></button>)}</div><small>{EXAMPLES.length}/2 curated demos · {EXAMPLES.length * RECIPES.length} real judgments · no key needed. These are demonstrations, not a quality benchmark.</small></div>}</div>
        <div className="gb-bank-heading"><div><h3>The brush cabinet</h3><span>{latestRanking ? latest?.source !== "lexical" ? "Ordered by Jev's description fit" : "Ordered by local tag matches" : "10 recipes · 5 ways to make a mark"}</span></div><button title={motionOn ? "Pause sample animation" : "Animate samples"} aria-label={motionOn ? "Pause sample animation" : "Animate samples"} onClick={() => setMotionOn(!motionOn)}>{motionOn && !reducedMotion ? <Pause size={14} /> : <Play size={14} />}</button></div>
        {latestRanking && <p className="gb-score-note">{latest?.source !== "lexical" ? "Fit scores are model judgments, not calibrated confidence. " : "Counts are a simple lexical baseline. "}{latestRanking[0].score === 0 ? "No tags matched; bank order breaks the tie." : "Equal scores keep the original bank order."}{latest?.events.at(-1)?.status === "discarded" && " This result is archived and was not applied to the current phrase."}{latest?.request.state.intent !== prompt.trim() && <span className="gb-prior-phrase">These scores belong to “{latest?.request.state.intent}”. The edited phrase has not been evaluated.</span>}</p>}
        <div className="gb-recipe-grid">{ordered.map((r, index) => { const selected = session.brushId === r.id, score = latestRanking?.find(x => x.id === r.id); return <motion.button layout={!reducedMotion} transition={{ duration: .25 }} key={r.id} className={`gb-recipe ${selected ? "selected" : ""}`} onClick={() => dispatch({ type: "select", id: r.id })} aria-pressed={selected} aria-label={`Use ${r.name}. ${r.description}`} style={{ "--gb-ink": r.ink, "--gb-delay": `${index * -.31}s` } as React.CSSProperties}><Sample stroke={compared} id={r.id} animate={motionOn && !reducedMotion} /><div><strong>{r.name}</strong>{selected && <Check size={13} />}<span>{r.family === "wind" ? "windblown" : r.family === "branch" ? "branching" : r.family === "grain" ? "granular" : r.family === "geometry" ? "geometric" : "woven"}{score && ` · ${latest?.source !== "lexical" ? score.score.toFixed(2) : `${score.score} tags`}`}</span></div></motion.button>; })}</div>
        <details className="gb-recipe-details"><summary>Inside {current.name}<ChevronDown size={14} /></summary><p>{current.description}</p><dl><div><dt>Spread</dt><dd>{current.width} units</dd></div><div><dt>Density</dt><dd>{current.density}</dd></div><div><dt>Irregularity</dt><dd>{current.energy}</dd></div></dl><p>Tags: {current.tags.join(", ")}</p></details>
      </aside>
    </div>
    <details className="gb-evidence"><summary>How this instrument works & decision receipts <ChevronDown size={15} /></summary><div><p>Pointer samples and a saved seed create each stroke. Jev evaluates text descriptions of a fixed recipe bank. Code chooses the highest fit score; equal scores keep bank order. No aesthetic accuracy or image understanding is claimed. The current recipe continues while requests are pending or unavailable.</p><p>Keyboard: focus the sheet, use arrow keys to move, Space to lower or lift the pen, Shift + arrows for larger moves, Escape to lift, and Ctrl/Command + Z to undo. Reduced motion disables sample animations. Drawing is limited to 80 strokes per sheet and 1,200 samples per stroke; preserved sheets remain available.</p><p>Original brushes by this project. Interaction inspiration: <a href="https://mrdoob.github.io/harmony/" target="_blank" rel="noreferrer">Harmony</a> and <a href="https://github.com/mattdesl/canvas-sketch" target="_blank" rel="noreferrer">canvas-sketch</a>. No brush code was copied. Version {ENGINE_VERSION}; protocol {PROTOCOL}.</p><div className="gb-receipts">{!session.receipts.length && <p>No style decisions yet. Drawing and hand-picked recipes need no model.</p>}{[...session.receipts].reverse().map(r => <details key={r.token.id}><summary><span>#{r.token.id} · {r.source === "recorded" ? "Recorded Jev · 10 judgments" : r.source === "jev" ? "Live Jev · 10 judgments" : "Local · tag counts"}</span><span>{r.events.at(-1)?.status}</span></summary><p>{r.request.state.intent}</p><ol>{r.events.map((e, i) => <li key={i}>{e.status}: {e.detail}</li>)}</ol><pre>{JSON.stringify(r, null, 2)}</pre></details>)}</div></div></details>
  </section>;
}
