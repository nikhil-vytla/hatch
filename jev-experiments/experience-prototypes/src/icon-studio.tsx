import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Check, Copy, Download, Pin, Search, X } from "lucide-react";
import { Button, Fold, Notice } from "./shared";
import { download, getApiKey, run } from "./api";
import { presets, shards, shardQuestion, finalQuestion, finalists, lexical, type LibraryIcon } from "../../icon-studio/protocol";
import "./icon-studio.css";

const xml = (s: unknown) => String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function svgText(icon: LibraryIcon, stroke: number, color: string, size: number) {
  const nodes = icon.node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([key]) => key !== "key").map(([key, value]) => `${key}="${xml(value)}"`).join(" ")}/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${xml(color)}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${nodes}</svg>`;
}
function Glyph({ icon, size = 24, stroke = 1.7, color = "currentColor" }: { icon?: LibraryIcon; size?: number; stroke?: number; color?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icon?.node.map(([tag, attrs], i) => createElement(tag, { ...attrs, key: attrs.key ?? i }))}</svg>;
}

export function IconStudio({ result }: { result: any }) {
  const [library, setLibrary] = useState<{ icons: LibraryIcon[]; version: string; sha256: string } | null>(null);
  const [title, setTitle] = useState(presets[0].title), [context, setContext] = useState(presets[0].context);
  const [selected, setSelected] = useState(""), [pinned, setPinned] = useState<string[]>([]), [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"all" | "finalists" | "pinned">("finalists"), [limit, setLimit] = useState(48);
  const [stroke, setStroke] = useState(1.7), [size, setSize] = useState(24), [color, setColor] = useState("#678a76");
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [live, setLive] = useState<any>(null), generation = useRef(0), controller = useRef<AbortController | null>(null), reduce = useReducedMotion();
  const saved = result.rows?.find((r: any) => r.title === title && r.context === context && r.status === "complete"), evidence = live ?? saved;
  const icons = library?.icons ?? [], byId = useMemo(() => new Map(icons.map(i => [i.id, i])), [icons]);
  const pick = selected || (evidence?.picked !== "none" ? evidence?.picked : ""), icon = byId.get(pick);
  const candidates = (evidence?.finalists ?? []).map((id: string) => byId.get(id)).filter(Boolean) as LibraryIcon[];
  const ranking = useMemo(() => lexical(icons, title, context), [icons, title, context]);
  const base = mode === "pinned" ? pinned.map(id => byId.get(id)).filter(Boolean) as LibraryIcon[] : mode === "finalists" && evidence ? candidates : ranking.map(r => r.icon);
  const visible = base.filter(i => !filter || i.label.includes(filter.toLowerCase())).slice(0, limit);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/icon-studio/collection.json", { signal: abort.signal }).then(r => { if (!r.ok) throw Error("The icon collection could not load."); return r.json(); }).then(data => {
      if (data.sha256 !== result.library.sha256) throw Error("The recorded choices and current icon library differ. Rebuild the collection before comparing them.");
      if (!abort.signal.aborted) setLibrary(data);
    }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [result.library.sha256]);
  useEffect(() => {
    setBusy(false);
    return () => { generation.current++; controller.current?.abort(); controller.current = null; setBusy(false); };
  }, [result.library.sha256]);
  function stop(message = "Stopped. A partial tournament is not presented as a final choice.") { generation.current++; controller.current?.abort(); controller.current = null; setBusy(false); setNotice(message); }
  function change(nextTitle: string, nextContext: string) { stop(""); setTitle(nextTitle); setContext(nextContext); setLive(null); setSelected(""); setError(""); setProgress(0); setLimit(48); }
  async function match() {
    if (!getApiKey()) { setError("Connect your own Gateway key using Connect live, then find an icon. The key stays in memory."); return; }
    if (!library || !title.trim()) return;
    const tag = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    setBusy(true); setError(""); setNotice(""); setProgress(0); setLive(null); setSelected("");
    const groups = shards(icons), answers: Record<string, any> = {}, calls: any[] = [], state = { title, context }, started = performance.now();
    try {
      for (let start = 0; start < groups.length; start += 8) {
        const questions = Object.fromEntries(groups.slice(start, start + 8).map((g, i) => ["shard_" + (start + i), shardQuestion(g)]));
        const output = await run(state, questions, abort.signal);
        if (tag !== generation.current || abort.signal.aborted) return;
        Object.assign(answers, output.answers); calls.push({ state, questions, output }); setProgress(Math.min(start + 8, groups.length));
      }
      const winners = finalists(groups, answers), questions = { icon: finalQuestion(winners) };
      const output = winners.length ? await run(state, questions, abort.signal) : null;
      if (tag !== generation.current || abort.signal.aborted) return;
      if (output) calls.push({ state, questions, output });
      const answer = output?.answers.icon, picked = answer?.value ?? "none";
      if (picked !== "none" && !winners.some(i => i.id === picked)) throw Error("The final answer is outside the candidate set.");
      setLive({ title, context, status: "complete", finalists: winners.map(i => i.id), shardAnswers: answers, answer, picked, calls, elapsed_ms: performance.now() - started }); setMode("finalists");
    } catch (e) { if (tag === generation.current && !abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (tag === generation.current) { setBusy(false); controller.current = null; } }
  }
  function pin(id: string) { setPinned(items => items.includes(id) ? items.filter(i => i !== id) : [...items, id]); }
  async function copy(kind: "svg" | "react") {
    if (!icon) return;
    const name = icon.id.split("-").map(s => s[0].toUpperCase() + s.slice(1)).join("");
    const value = kind === "svg" ? svgText(icon, stroke, color, size) : `import { ${name} } from "lucide-react";\n\n<${name} size={${size}} strokeWidth={${stroke}} color="${color}" aria-hidden="true" />`;
    try { await navigator.clipboard.writeText(value); setNotice(`Copied ${kind === "svg" ? "SVG" : "React snippet"} for ${icon.label}. Keep Lucide's license with redistributed assets.`); }
    catch { setError("Clipboard access is unavailable. Download the SVG instead."); }
  }
  return <div className="icon-studio">
    <header className="is-hero"><span className="is-kicker">A word, a symbol, a place to use it</span><h2>Give an idea<br />a little shape.</h2><p>Find a familiar symbol for an unfamiliar phrase.<br />Then see whether it works where people will use it.</p></header>
    <div className="is-presets" aria-label="Recorded icon searches">{presets.map(p => <button key={p.id} className={title === p.title && context === p.context ? "selected" : ""} onClick={() => change(p.title, p.context)}>{p.title}</button>)}</div>
    <div className="is-workbench"><section className="is-intent"><label>What does the element say?<input value={title} maxLength={200} onChange={e => change(e.target.value, context)} /></label><label>Where will someone use it?<textarea rows={3} value={context} maxLength={1500} onChange={e => change(title, e.target.value)} /></label><div className="is-run">{busy ? <Button secondary onClick={() => stop()}><X size={14} /> Stop search</Button> : <Button onClick={match} disabled={!library || !title.trim()}><Search size={14} /> Find with Jev</Button>}<small>{busy ? `${progress}/${Math.ceil(icons.length / 64)} groups evaluated` : live ? "Your live search" : saved ? "Recorded search" : "Browse locally or connect a key"}</small></div>{busy && <div className="is-progress"><motion.i animate={{ width: `${progress / Math.ceil(icons.length / 64) * 100}%` }} transition={{ duration: reduce ? 0 : .25 }} /></div>}<p className="is-help">Jev chooses among {icons.length || result.library.count} existing Lucide icons using their names. The artwork comes from the library. Group winners meet in a final comparison.</p></section>
    <section className="is-preview" aria-label="Selected icon in product contexts"><div className="is-preview-top"><span>{selected ? "Your selection" : evidence ? "Jev’s selection" : "Select an icon below"}</span><button disabled={!icon} onClick={() => icon && pin(icon.id)} aria-label={icon && pinned.includes(icon.id) ? "Unpin selected icon" : "Pin selected icon"}><Pin size={15} fill={icon && pinned.includes(icon.id) ? "currentColor" : "none"} /></button></div><div className="is-specimen"><motion.div key={pick} initial={{ opacity: reduce ? 1 : 0, scale: reduce ? 1 : .85 }} animate={{ opacity: 1, scale: 1 }}><Glyph icon={icon} size={76} stroke={stroke} color={color} /></motion.div><strong>{icon?.label ?? (evidence?.picked === "none" ? "No suitable icon" : "A symbol belongs here")}</strong></div><div className="is-contexts"><div className="is-context-nav"><span>Workspace</span><div className="is-context-item"><Glyph icon={icon} size={size} stroke={stroke} color={color} /><span>{title || "Your label"}</span><small>12</small></div></div><div className="is-context-card"><Glyph icon={icon} size={Math.max(24, size)} stroke={stroke} color={color} /><strong>{title || "Your label"}</strong><span>See it as a feature card</span></div><div className="is-context-action"><span className="is-preview-button"><Glyph icon={icon} size={size} stroke={stroke} color={color} />{title || "Your label"}</span><small>Button preview</small></div></div><div className="is-style"><label>Stroke <b>{stroke.toFixed(1)}</b><input aria-label="Icon stroke width" type="range" min="1" max="3" step="0.1" value={stroke} onChange={e => setStroke(Number(e.target.value))} /></label><label>Size <b>{size}px</b><input aria-label="Icon size" type="range" min="16" max="32" step="2" value={size} onChange={e => setSize(Number(e.target.value))} /></label><label>Color<input aria-label="Icon color" type="color" value={color} onChange={e => setColor(e.target.value)} /></label></div><div className="is-export"><button disabled={!icon} onClick={() => copy("svg")}><Copy size={12} /> Copy SVG</button><button disabled={!icon} onClick={() => copy("react")}>React</button><button disabled={!icon} onClick={() => icon && download(`${icon.id}.svg`, svgText(icon, stroke, color, size), "image/svg+xml")}><Download size={12} /> SVG</button></div></section></div>
    {error && <Notice error>{error}</Notice>}{notice && <Notice>{notice}</Notice>}
    <div className="is-gallery-toolbar"><div>{(["finalists", "all", "pinned"] as const).map(m => <button className={mode === m ? "selected" : ""} key={m} onClick={() => { setMode(m); setLimit(48); }}>{m === "finalists" ? "Jev finalists" : m === "all" ? "Whole library" : `Pinned · ${pinned.length}`}</button>)}</div><label><Search size={14} /><input aria-label="Filter icons by name" placeholder="Filter by icon name" value={filter} onChange={e => { setFilter(e.target.value); setLimit(48); }} /></label></div>
    <p className="is-gallery-note">{mode === "finalists" && evidence ? `${candidates.length} group winners. Shown alphabetically, not as a global ranking.` : mode === "pinned" ? "Your shortlist stays here while you explore other contexts. Pins stay in this page only." : "All library icons, ordered by a simple keyword match. This local baseline does not understand your intent."}{evidence?.picked === "none" && " Jev abstained in the final comparison."}</p>
    <div className="is-grid">{[...visible].sort((a, b) => mode === "finalists" && evidence ? a.id.localeCompare(b.id) : 0).map(candidate => <article key={candidate.id} className={pick === candidate.id ? "selected" : ""}><button className="is-icon-choice" onClick={() => { setSelected(candidate.id); setNotice(""); }} aria-label={`Preview ${candidate.label}`} aria-pressed={pick === candidate.id}><Glyph icon={candidate} size={30} stroke={stroke} /><span>{candidate.label}</span>{evidence?.picked === candidate.id && <i title="Jev selected this icon"><Check size={12} /></i>}</button><button className="is-pin" onClick={() => pin(candidate.id)} aria-label={`${pinned.includes(candidate.id) ? "Unpin" : "Pin"} ${candidate.label}`}><Pin size={11} fill={pinned.includes(candidate.id) ? "currentColor" : "none"} /></button></article>)}</div>
    {!visible.length && <p className="is-empty">{mode === "pinned" ? "Pin a few icons to compare them here." : "No icons match this view. Clear the filter or open the whole library."}</p>}{base.filter(i => !filter || i.label.includes(filter.toLowerCase())).length > visible.length && <Button secondary onClick={() => setLimit(n => n + 96)}>Show more icons</Button>}
    <Fold title="What Jev sees, candidate groups, and source artwork"><p>Library: Lucide {result.library.version}, {result.library.count} canonical icons. Every icon enters one shuffled group of at most 64 choices, with an explicit None option. Group winners enter a final Choice. This two-stage search can miss an icon eliminated in an earlier group; changing the grouping may change the winner. It is not a global suitability ranking. The returned probabilities are conditional on each candidate set.</p><p>Six authored product examples demonstrate selection. They have no independent preference labels and are not an accuracy benchmark. Stroke, color and size are manual styling controls; Jev does not generate or inspect these SVGs.</p><div className="is-links"><a href="https://lucide.dev/icons/" target="_blank" rel="noreferrer">Lucide icons <ArrowUpRight size={12} /></a><a href="/icon-studio/LICENSE.txt" target="_blank" rel="noreferrer">Artwork license</a><a href="https://github.com/sandra-arato/icon-matcher-ui" target="_blank" rel="noreferrer">Original picker inspiration <ArrowUpRight size={12} /></a><a href="/icon-studio/evidence.jsonl" download>Recorded requests and answers</a></div><pre className="code">{JSON.stringify({ title, context, evidence: evidence ?? null, library: result.library }, null, 2)}</pre><Button secondary onClick={() => download("icon-search.json", { title, context, selection: pick, pinned, style: { stroke, color, size }, evidence: evidence ?? null, library: result.library })}>Export this comparison</Button></Fold>
  </div>;
}
