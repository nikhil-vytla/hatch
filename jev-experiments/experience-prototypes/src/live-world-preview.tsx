import { useEffect, useRef } from "react";
import { STEP, advance, createWorld, setController, setNotice } from "../../live-worlds/crowd/engine";
import { paint, VIEW } from "../../live-worlds/crowd/render";
import "./live-world-preview.css";

/** Local-only illustration. It never imports a key, provider or recorded model decision. */
export function LiveWorldPreview() {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = root.current, surface = canvas.current;
    if (!element || !surface) return;
    const context = surface.getContext("2d"); if (!context) return;
    const world = createWorld(27, "home-local-preview");
    setController(world, "notice");
    setNotice(world, "Fresh bread, a quiet corner, and a little music.");
    for (let i = 0; i < 90; i++) advance(world);
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false, disposed = false, frame = 0, previous = 0, lastPaint = 0, remainder = 0;
    const draw = () => {
      const box = element.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(box.width * dpr)), height = Math.max(1, Math.round(box.height * dpr));
      if (surface.width !== width || surface.height !== height) { surface.width = width; surface.height = height; }
      const scale = Math.max(width / VIEW.width, height / VIEW.height);
      context.setTransform(scale, 0, 0, scale, (width - VIEW.width * scale) / 2, (height - VIEW.height * scale) / 2);
      paint(context, world, "", motion.matches, document.documentElement.dataset.theme === "dark");
      element.dataset.worldTick = String(world.tick);
    };
    const canRun = () => !disposed && visible && !document.hidden && !motion.matches;
    const loop = (now: number) => {
      frame = 0; if (!canRun()) return;
      remainder += Math.max(0, now - previous) / 1000; previous = now;
      // Keep active elapsed time, with bounded work per paint; paused time is excluded.
      let count = 0; while (remainder >= STEP && count < 12) { advance(world); remainder -= STEP; count++; }
      if (now - lastPaint >= 1000 / 30) { draw(); lastPaint = now; }
      frame = requestAnimationFrame(loop);
    };
    const sync = () => {
      element.dataset.previewState = document.hidden ? "hidden" : motion.matches ? "reduced-motion" : visible ? "running" : "offscreen";
      if (canRun()) { if (!frame) { previous = performance.now(); remainder = 0; frame = requestAnimationFrame(loop); } }
      else { cancelAnimationFrame(frame); frame = 0; remainder = 0; if (visible && !document.hidden) draw(); }
    };
    const intersection = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); sync(); }, { threshold: 0 });
    const resize = new ResizeObserver(() => draw());
    const theme = new MutationObserver(() => { if (visible && !document.hidden) draw(); });
    intersection.observe(element); resize.observe(element); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    document.addEventListener("visibilitychange", sync); motion.addEventListener("change", sync);
    draw(); sync();
    return () => { disposed = true; cancelAnimationFrame(frame); intersection.disconnect(); resize.disconnect(); theme.disconnect(); document.removeEventListener("visibilitychange", sync); motion.removeEventListener("change", sync); };
  }, []);
  return <div ref={root} className="live-world-preview" data-preview-state="starting"><canvas ref={canvas} aria-hidden="true" /><div className="lwp-caption-shade" aria-hidden="true" /><span className="lwp-local-label"><i aria-hidden="true" /> Local world preview</span></div>;
}

const COLORS = ["#89a98c", "#bf836a", "#7b9fae", "#baa1bf", "#ceb174"];
function Figure({ x, y, color, scale = 1 }: { x: number; y: number; color: string; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}><ellipse cy="21" rx="10" ry="3" fill="#384f4120" /><path d="M-4 7l-2 13m10-13 2 13" stroke="#516452" strokeWidth="4" strokeLinecap="round" /><rect x="-8" y="-10" width="16" height="22" rx="6" fill={color} /><circle cy="-18" r="7" fill="#dfb88e" /><path d="M-7-19a7 7 0 0 1 14 0" fill="#655749" /></g>;
}
function TetrisThumbnail() {
  const settled = [[0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [0, 5], [1, 5], [3, 5], [4, 5], [0, 4], [4, 4]];
  return <>{[83, 218].map((x, lane) => <g key={x} transform={`translate(${x} 30)`}><rect width="88" height="149" rx="8" fill="#223b3c" /><g transform="translate(7 13)">{Array.from({ length: 35 }, (_, i) => <rect key={i} x={(i % 5) * 15} y={Math.floor(i / 5) * 17} width="13" height="15" rx="2" fill="#344c49" />)}{settled.map(([a, b], i) => <rect key={i} x={a * 15} y={b * 17} width="13" height="15" rx="2" fill={COLORS[(i + lane) % COLORS.length]} />)}<g fill={lane ? "#cab5d5" : "#90bcc8"}>{[[1, 1], [2, 1], [3, 1], [2, 2]].map(([a, b]) => <rect key={`${a}${b}`} x={a * 15} y={b * 17} width="13" height="15" rx="2" />)}</g><rect x="30" y="85" width="13" height="15" rx="2" fill="none" stroke="#dbe2c7" strokeDasharray="3 2" /></g></g>)}<path d="M180 92h27m-7-5 7 5-7 5M180 108h27m-7-5 7 5-7 5" stroke="var(--lwp-muted)" strokeWidth="1.5" fill="none" /><path d="M62 164v18h256v-18" stroke="var(--lwp-muted)" strokeWidth="1" fill="none" opacity=".3" /></>;
}
function CrowdThumbnail() {
  return <><rect x="44" y="27" width="294" height="153" rx="18" fill="var(--lwp-ground)" /><path d="M75 75h236M84 148h222M188 69v81" stroke="var(--lwp-path)" strokeWidth="30" strokeLinecap="round" /><g><rect x="72" y="37" width="55" height="43" rx="4" fill="var(--lwp-paper)" /><rect x="67" y="31" width="65" height="13" rx="3" fill="#b98769" /><path d="M87 63h10m10 0h9" stroke="#94b0a0" strokeWidth="11" /><rect x="254" y="37" width="48" height="43" rx="4" fill="var(--lwp-paper)" /><path d="M248 37h60" stroke="#b5a079" strokeWidth="13" strokeLinecap="round" /></g><g fill="#8da988"><circle cx="60" cy="123" r="13" /><circle cx="318" cy="112" r="15" /><circle cx="239" cy="156" r="12" /><circle cx="151" cy="38" r="10" /></g><ellipse cx="188" cy="154" rx="26" ry="13" fill="#8eb3b7" /><ellipse cx="188" cy="151" rx="17" ry="6" fill="none" stroke="#d5e2ce" /><path d="M177 99h23v20h-23z" fill="#c6aa79" /><path d="M180 105h16m-16 5h12" stroke="#755f42" strokeWidth="1.2" /><Figure x={147} y={89} color="#b17984" scale={.65} /><Figure x={214} y={127} color="#789bad" scale={.65} /><Figure x={96} y={148} color="#b9925d" scale={.65} /><Figure x={277} y={100} color="#879868" scale={.65} /></>;
}
function BrushThumbnail() {
  return <><rect x="47" y="29" width="286" height="152" rx="5" fill="var(--lwp-paper)" transform="rotate(-3 190 105)" /><g fill="none" strokeLinecap="round">{Array.from({ length: 7 }, (_, i) => <path key={i} d={`M75 ${131 + i * 2}C118 ${161 - i * 3} 135 ${50 + i * 4} 183 ${72 + i * 2}S253 ${155 - i * 2} 304 ${77 + i * 3}`} stroke={i % 3 ? "#747aa4" : "#c28a6e"} strokeWidth={.8} opacity={.7} />)}{Array.from({ length: 16 }, (_, i) => { const x = 96 + i * 12, y = 125 + Math.sin(i * .45) * 23; return <path key={i} d={`M${x} ${y}l12 -18m-7 10 14 -6`} stroke="#719c87" strokeWidth=".75" opacity=".6" />; })}</g><g transform="rotate(-30 279 145)"><rect x="275" y="115" width="6" height="49" rx="3" fill="#8a755a" /><path d="m275 115 3-15 3 15" fill="#51644e" /></g><circle cx="73" cy="53" r="4" fill="#8993b3" /><circle cx="86" cy="53" r="4" fill="#90ac95" /><circle cx="99" cy="53" r="4" fill="#c39780" /></>;
}
function ArchiveThumbnail() {
  return <>{Array.from({ length: 6 }, (_, i) => { const x = 66 + (i % 3) * 86, y = 23 + Math.floor(i / 3) * 85; return <g key={i} transform={`translate(${x} ${y})`}><rect width="73" height="76" rx="3" fill="var(--lwp-paper)" /><rect x="5" y="5" width="63" height="57" rx="1" fill={["#d6dbc2", "#c6d3d4", "#dccdb3", "#d4c5c0", "#cbd5bd", "#cfccd5"][i]} />{i % 3 === 0 ? <><circle cx="48" cy="21" r="10" fill="#ba8862" /><path d="M5 57 29 30 68 57v5H5z" fill="#7f987e" /><path d="M5 62 37 43 68 62" fill="#567a76" /></> : i % 3 === 1 ? <><path d="M35 58V18m0 21L19 26m16 20 17-17" stroke="#688875" strokeWidth="2" /><ellipse cx="24" cy="27" rx="9" ry="5" fill="#94a479" transform="rotate(35 24 27)" /><ellipse cx="47" cy="30" rx="10" ry="5" fill="#6d947f" transform="rotate(-35 47 30)" /></> : <><rect x="16" y="16" width="21" height="36" fill="#bc886e" transform="rotate(15 26 34)" /><circle cx="47" cy="34" r="16" fill="#8e97aa" opacity=".85" /></>}<path d="M12 69h32" stroke="var(--lwp-muted)" strokeWidth="2" opacity=".35" /></g>; })}<g transform="translate(309 162)"><circle r="14" fill="var(--lwp-paper)" stroke="var(--lwp-muted)" strokeWidth="1.3" /><circle r="5" fill="none" stroke="var(--lwp-ink)" strokeWidth="1.5" /><path d="m4 4 5 5" stroke="var(--lwp-ink)" strokeWidth="1.5" /></g></>;
}
function WardrobeThumbnail() {
  return <>{[99, 249].map((x, i) => <g key={x} transform={`translate(${x} 105)`}><rect x="-44" y="-77" width="88" height="148" rx="11" fill="var(--lwp-paper)" /><circle cy="-48" r="11" fill="#d9b597" /><path d="M-11-14-13 43h11l3-35 3 35h11L11-14" fill="#596b73" /><path d="M-13-29-30-17l9 26 10-5 1 14h24L13 4l10 5 8-26-19-12z" fill={i ? "#91a383" : "#b98576"} /><path d={i ? "M0-25v42m-10-35 10 12 12-12" : "M-8-27q8 11 16 0"} stroke={i ? "#647c60" : "#98695f"} strokeWidth="1.4" fill="none" /><path d="M-12 44h10m6 0h10" stroke="#6b6052" strokeWidth="5" strokeLinecap="round" /></g>)}<path d="M155 98h38m-8-7 8 7-8 7" fill="none" stroke="var(--lwp-muted)" strokeWidth="1.5" strokeLinecap="round" /><path d="M156 117h26" stroke="var(--lwp-muted)" strokeWidth="2" opacity=".25" /></>;
}
const ICON_PATHS = ["M-10-5 0-13 10-5V11H3V2h-6v9h-7z", "M-11-9H2q7 0 9 4v17q-4-5-11-3-7-2-11 3zM0-7V9", "M-10 10 0-12 10 10zM-5 1H5", "M0-12 3-3 12 0 3 3 0 12-3 3-12 0-3-3z", "M-12 2q0-8 8-8 3-8 10-3 8 0 7 9 5 2 3 8h-24q-7-1-4-6", "M-10-8H10V8H3l-7 6V8h-6z", "M-11-9-1-5l12-4v19l-12 4-10-4zM-1-5v19", "M0-12V12M-12 0H12M-8-8 8 8M-8 8 8-8", "M-10-5h20v16h-20zM-5-5v-5h10v5"];
function IconThumbnail() {
  return <>{ICON_PATHS.map((d, i) => <g key={i} transform={`translate(${112 + i % 3 * 74} ${49 + Math.floor(i / 3) * 56})`}><rect x="-28" y="-23" width="56" height="46" rx="7" fill={i === 3 ? "var(--lwp-selection)" : "var(--lwp-paper)"} stroke={i === 3 ? "#789a85" : "none"} strokeWidth="1.5" /><path d={d} stroke={i === 3 ? "#527963" : "var(--lwp-muted)"} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></g>)}</>;
}
function PixelsThumbnail() {
  return <>{[58, 202].map((x, panel) => <g key={x} transform={`translate(${x} 34)`}><rect width="122" height="141" rx="5" fill="var(--lwp-paper)" />{Array.from({ length: 100 }, (_, i) => { const cx = i % 10, cy = Math.floor(i / 10), on = (cx - 4.5) ** 2 + (cy - 4) ** 2 < 12 || cy >= 6 && cx >= 4 && cx <= 5; return <rect key={i} x={12 + cx * 10} y={11 + cy * 10} width="8" height="8" rx={panel ? 1.5 : .5} fill={on ? cy > 6 ? "#74957b" : panel ? COLORS[(cx + cy) % 3] : "#b98976" : "var(--lwp-grid)"} opacity={on && panel ? .5 + (cx % 3) * .2 : 1} />; })}<path d="M13 123h61m-61 5h36" stroke="var(--lwp-muted)" strokeWidth="2" opacity=".3" /></g>)}<path d="M186 90h10m-5-4 5 4-5 4" stroke="var(--lwp-muted)" fill="none" /></>;
}
/** Decorative code-native card art, not recorded model outputs or source artwork. */
export function MiniExperimentPreview({ kind }: { kind: string }) {
  const content = kind === "tetris" ? <TetrisThumbnail /> : kind === "crowd" ? <CrowdThumbnail /> : kind === "ghost-brush" ? <BrushThumbnail /> : kind === "visual-search" ? <ArchiveThumbnail /> : kind === "wardrobe" ? <WardrobeThumbnail /> : kind === "icon-studio" ? <IconThumbnail /> : kind === "drawing-framing" ? <PixelsThumbnail /> : null;
  return content ? <svg className="mini-experiment-preview" viewBox="0 0 380 208" aria-hidden="true" focusable="false" data-preview-kind={kind}>{content}</svg> : null;
}
