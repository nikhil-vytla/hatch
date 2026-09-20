import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Square, Download, LockKeyhole, LockKeyholeOpen, Volume2, VolumeX, Undo2, RotateCcw, ArrowUp, ArrowDown, Sparkles, Headphones } from "lucide-react";
import { Button, Field, Notice, State, Fold, Bars } from "./shared";
import { run, download, getApiKey } from "./api";
import { starterScore, makeCandidates, applyCandidate, phraseRequest, globalRequest, settingsFromAnswers, blankScore, playbackEvents, populateMidi, editNote, setTrack, stepPitch, noteName, keyName, CONTOURS, INSTRUMENTS, BarScore, Generation, type Score, type ScoreEvent, type Candidate, type InstrumentId } from "../../music-arranger-v2/engine";
import "./music-arranger.css";

type AudioEngine = { box: BarScore; dispose: () => void };
function MiniContour({ candidate }: { candidate: Candidate }) {
  const notes = candidate.events.filter(e => e.track === "melody"), pitches = notes.flatMap(e => e.midi === null ? [] : [e.midi]);
  const low = Math.min(...pitches) - 2, high = Math.max(...pitches) + 2;
  return <svg viewBox="0 0 160 42" aria-hidden="true">{notes.map(e => <rect key={e.id} x={(e.beat % 8) * 20 + 1} y={e.midi === null ? 36 : 5 + (high - e.midi) / (high - low) * 25} width={Math.max(2, e.duration * 20 - 3)} height={e.midi === null ? 1 : 5} rx="2" opacity={e.midi === null ? 0.3 : 0.85} />)}</svg>;
}
function Film({ phrase, playing }: { phrase: number; playing: boolean }) {
  const captions = ["The station is quiet.", "A light appears in the distance.", "The train draws closer.", "Someone is coming home."];
  return <div className={`ma-film ma-scene-${phrase} ${playing ? "is-playing" : ""}`}>
    <div className="ma-film-grain" />
    <svg viewBox="0 0 840 200" role="img" aria-label={`An illustrated night-time station. ${captions[phrase]}`}>
      <defs><linearGradient id="ma-sky" x2="0" y2="1"><stop stopColor="#152d39"/><stop offset="1" stopColor="#3c646b"/></linearGradient><radialGradient id="ma-light"><stop stopColor="#ffe5a5" stopOpacity=".65"/><stop offset="1" stopColor="#ffe5a5" stopOpacity="0"/></radialGradient></defs>
      <rect width="840" height="200" fill="url(#ma-sky)"/><circle cx="641" cy="43" r="16" fill="#ded9b4" opacity=".8"/>
      {[65,126,255,390,490,575,727,781].map((x,i)=><circle key={x} cx={x} cy={18+(i*17)%67} r="1" fill="#d7e3db" opacity=".55"/>)}
      <path d="M0 117L82 81L152 116L222 89L327 116L425 91L525 126L640 103L734 121L840 86V200H0Z" fill="#18333b"/>
      <path d="M0 162H840V200H0Z" fill="#122630"/><path d="M0 173H840M0 180H840" stroke="#8ca6a4" opacity=".3"/>
      <g className="ma-train" style={{ transform: `translateX(${[-680,-390,-70,90][phrase]}px)` }}><rect x="65" y="114" width="300" height="40" rx="12" fill="#a9bcb3"/><path d="M325 115h30l16 20h-46z" fill="#cbd5c0"/>{[85,126,167,208,249,290].map(x=><rect key={x} x={x} y="122" width="25" height="15" rx="2" fill="#eddb9b"/>)}<rect x="74" y="143" width="282" height="3" fill="#577c7b"/><circle cx="105" cy="157" r="7" fill="#0d202a"/><circle cx="312" cy="157" r="7" fill="#0d202a"/><ellipse cx="382" cy="137" rx="90" ry="30" fill="url(#ma-light)"/></g>
      <path d="M0 166h840v5H0z" fill="#c0bea5"/><path d="M120 153V88H300V153M107 91h207l-28-21H133z" fill="#1b333b" stroke="#a7b1a1" strokeWidth="2"/><path d="M162 153v-45h101v45" fill="#304e54"/><rect x="204" y="111" width="29" height="36" fill="#e8cf8d" opacity=".78"/><rect x="138" y="114" width="44" height="17" fill="#8fa9a6" opacity=".6"/>
      <g><path d="M430 164V85h30" fill="none" stroke="#9eaaa0" strokeWidth="3"/><path d="M448 86h24l-5 8h-14z" fill="#e7d39b"/><ellipse cx="460" cy="136" rx="53" ry="46" fill="url(#ma-light)"/></g>
      <g transform={`translate(${phrase===3?492:550} 0)`}><circle cy="140" r="4" fill="#d5c7a8"/><path d="M-5 146h10l2 13H-7z" fill="#b88974"/><path d="M-3 157v8m6-8v8" stroke="#b8c3ba" strokeWidth="2"/></g>
      <path d="M575 159h60m-53-8v13m44-13v13" stroke="#8b9e97" strokeWidth="3"/>
    </svg>
    <div className="ma-film-caption"><span>Score a tiny film</span><strong>{captions[phrase]}</strong><small>Scene {phrase + 1} of 4 · bars {phrase * 2 + 1}–{phrase * 2 + 2}</small></div>
  </div>;
}
function PianoRoll({ score, beat, selected, onSelect }: { score: Score; beat: number; selected: string; onSelect: (id: string) => void }) {
  const melody = score.events.filter(e => e.track === "melody"), pitched = melody.flatMap(e => e.midi === null ? [] : [e.midi]);
  const low = Math.min(57, ...pitched) - 1, high = Math.max(80, ...pitched) + 1, range = high - low;
  return <div className="ma-roll-scroll"><div className="ma-roll" role="group" aria-label="Melody piano roll. Select a note to edit its pitch, duration or rest.">
    <div className="ma-roll-labels"><span>{noteName(high)}</span><span>Melody</span><span>{noteName(low)}</span></div>
    <div className="ma-roll-grid">
      {Array.from({ length: 9 }, (_,i) => <span key={i} className="ma-barline" style={{ left: `${i * 12.5}%` }}><small>{i < 8 ? i + 1 : ""}</small></span>)}
      {melody.map(e => <button type="button" key={e.id} className={`ma-note ${e.midi === null ? "is-rest" : ""} ${selected === e.id ? "is-selected" : ""} ${beat >= e.beat && beat < e.beat + e.duration ? "is-sounding" : ""}`} style={{ left: `${e.beat / 32 * 100}%`, width: `${e.duration / 32 * 100}%`, top: e.midi === null ? "93%" : `${(high - e.midi) / range * 86}%` }} aria-label={`${e.midi === null ? "Rest" : noteName(e.midi)}, bar ${Math.floor(e.beat / 4) + 1}, beat ${e.beat % 4 + 1}, ${e.duration} beats${score.phrases[e.phrase].locked ? ", locked" : ""}`} aria-pressed={selected === e.id} onClick={() => onSelect(e.id)}>{e.midi === null ? "·" : ""}</button>)}
      {beat >= 0 && <div className="ma-playhead" style={{ left: `${beat / 32 * 100}%` }} />}
    </div>
  </div></div>;
}
export function makeAudio(Tone: typeof import("tone"), score: Score, onBeat: (beat: number, active: Score) => void, isCurrent: () => boolean, startPhrase = 0, audition = false): AudioEngine {
  const box = new BarScore(score), limiter = new Tone.Limiter(-1).toDestination(), bus = new Tone.Volume(-9).connect(limiter), voices: Record<string, any> = {};
  const add = (id: string, options: any, fm = false) => { voices[id] = fm ? new Tone.PolySynth(Tone.FMSynth, options).connect(bus) : new Tone.PolySynth(Tone.Synth, options).connect(bus); voices[id].maxPolyphony = 16; };
  add("flute", { oscillator: { type: "sine" }, envelope: { attack: .025, decay: .08, sustain: .65, release: .09 } });
  add("reed", { oscillator: { type: "triangle" }, envelope: { attack: .03, decay: .1, sustain: .65, release: .1 } });
  add("bell", { harmonicity: 3.01, modulationIndex: 2.5, envelope: { attack: .004, decay: .6, sustain: .08, release: .16 }, modulationEnvelope: { attack: .004, decay: .4, sustain: .05, release: .1 } }, true);
  add("pluck", { oscillator: { type: "triangle" }, envelope: { attack: .002, decay: .18, sustain: .12, release: .08 } });
  add("mallet", { harmonicity: 2, modulationIndex: 1.3, envelope: { attack: .002, decay: .15, sustain: .05, release: .05 } }, true);
  add("piano", { harmonicity: 1, modulationIndex: 1.5, envelope: { attack: .003, decay: .25, sustain: .18, release: .09 } }, true);
  add("organ", { oscillator: { type: "sine4" }, envelope: { attack: .012, decay: .05, sustain: .75, release: .06 } });
  add("velvet", { oscillator: { type: "sine" }, envelope: { attack: .14, decay: .1, sustain: .65, release: .12 } });
  add("strings", { oscillator: { type: "triangle" }, envelope: { attack: .24, decay: .2, sustain: .5, release: .15 } });
  add("round", { oscillator: { type: "sine" }, envelope: { attack: .006, decay: .12, sustain: .65, release: .06 } });
  add("picked", { oscillator: { type: "triangle" }, envelope: { attack: .002, decay: .15, sustain: .25, release: .06 } });
  const kick = new Tone.MembraneSynth({ pitchDecay: .025, octaves: 3, envelope: { attack: .001, decay: .08, sustain: .03, release: .04 } }).connect(bus);
  const snare = new Tone.NoiseSynth({ noise: { type: "pink" }, envelope: { attack: .001, decay: .045, sustain: .03, release: .02 } }).connect(bus);
  const hat = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: .001, decay: .015, sustain: .01, release: .012 } }).connect(bus);
  const hatFilter = new Tone.Filter(6500, "highpass").connect(bus); hat.disconnect(); hat.connect(hatFilter);
  let disposed = false, cached = score, events = playbackEvents(score), tick = startPhrase * 64;
  const clock = new Tone.Clock(time => {
    if (disposed || !isCurrent()) return;
    const span = audition ? 64 : 256, offset = audition ? startPhrase * 64 : 0, beat = (offset + (tick - offset) % span) / 8;
    const active = box.atBeat(beat);
    if (cached !== active) { cached = active; events = playbackEvents(active); clock.frequency.setValueAtTime(active.settings.bpm / 60 * 8, time); }
    for (const e of events) if (Math.abs(e.beat - beat) < 1e-7) {
      const duration = e.duration * 60 / active.settings.bpm;
      if (e.track === "drums") {
        if (e.midi === 36) kick.triggerAttackRelease(Tone.Frequency(e.midi, "midi").toFrequency(), duration, time, e.velocity);
        else (e.midi === 38 ? snare : hat).triggerAttackRelease(duration, time, e.velocity);
      } else voices[e.instrument].triggerAttackRelease(Tone.Frequency(e.midi, "midi").toFrequency(), duration, time, e.velocity);
    }
    // Tone Draw synchronizes the UI to the same scheduled audio time.
    Tone.getDraw().schedule(() => { if (!disposed && isCurrent()) onBeat(beat, active); }, time);
    tick++;
  }, score.settings.bpm / 60 * 8);
  clock.start(Tone.now() + .06);
  return { box, dispose: () => { if (disposed) return; disposed = true; clock.stop(); clock.dispose(); Object.values(voices).forEach(v => v.dispose()); kick.dispose(); snare.dispose(); hat.dispose(); hatFilter.dispose(); bus.dispose(); limiter.dispose(); } };
}
export function Music({ result }: { result: any }) {
  const rows = useMemo(() => (result?.rows ?? []).filter((r: any) => r.status === "complete" && r.score?.engine), [result]);
  const [comparison, setComparison] = useState("jev");
  const [rowIndex, setRowIndex] = useState(0), [score, setScore] = useState<Score>(() => rows[0]?.score ?? starterScore()), [heard, setHeard] = useState<Score | null>(null);
  const [phrase, setPhrase] = useState(0), [selected, setSelected] = useState(""), [beat, setBeat] = useState(-1), [status, setStatus] = useState<"idle" | "starting" | "playing">("idle"), [pending, setPending] = useState(false), [audition, setAudition] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [recommendation, setRecommendation] = useState<{ candidate: Candidate; result: any; version: number; phrase: number; request: any } | null>(null), [history, setHistory] = useState<Score[]>([]);
  const engine = useRef<AudioEngine | null>(null), startGeneration = useRef(new Generation()), modelGeneration = useRef(new Generation()), latest = useRef(score), abort = useRef<AbortController | null>(null), alive = useRef(true);
  const playing = status === "playing", locked = score.phrases[phrase].locked, candidates = useMemo(() => makeCandidates(score, phrase), [score, phrase]);
  const note = score.events.find(e => e.id === selected), displayedScore = playing && heard ? heard : score, displayedPhrase = playing && beat >= 0 ? Math.floor(beat / 8) : phrase;
  function stop() { startGeneration.current.next(); engine.current?.dispose(); engine.current = null; setStatus("idle"); setBeat(-1); setPending(false); setHeard(null); setAudition(""); }
  function cancelRequest() { modelGeneration.current.next(); abort.current?.abort(); abort.current = null; setBusy(false); }
  useEffect(() => { alive.current = true; return () => { alive.current = false; startGeneration.current.next(); modelGeneration.current.next(); abort.current?.abort(); engine.current?.dispose(); engine.current = null; }; }, []);
  function commit(next: Score, remember = true) {
    if (next === latest.current) return;
    cancelRequest(); setRecommendation(null);
    if (remember) setHistory(h => [...h.slice(-19), latest.current]);
    latest.current = next; setScore(next);
    if (audition) { stop(); return; }
    if (engine.current) { engine.current.box.queue(next); setPending(true); }
    // A pending start must never install a stale score.
    else if (status === "starting") stop();
  }
  async function play(target = latest.current, preview = "", previewPhrase = phrase) {
    stop(); const token = startGeneration.current.next(); setStatus("starting"); setError(""); setAudition(preview);
    try {
      const Tone = await import("tone"); if (!alive.current || !startGeneration.current.valid(token)) return;
      await Tone.start(); if (!alive.current || !startGeneration.current.valid(token)) return;
      const next = makeAudio(Tone, target, (b, active) => { setBeat(b); setHeard(active); if (active.version === latest.current.version) setPending(false); }, () => alive.current && startGeneration.current.valid(token), previewPhrase, !!preview);
      if (!alive.current || !startGeneration.current.valid(token)) { next.dispose(); return; }
      engine.current = next; setHeard(target); setStatus("playing");
    } catch (e) { if (alive.current && startGeneration.current.valid(token)) { stop(); setError(e instanceof Error ? e.message : String(e)); } }
  }
  async function askJev() {
    if (!getApiKey()) { setError("Connect your Vercel AI Gateway key above to ask Jev. Recorded arrangements, editing and playback work without a key."); return; }
    cancelRequest(); const token = modelGeneration.current.next(), version = latest.current.version, index = phrase, snapshot = latest.current;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError(""); setMessage("");
    const pool = makeCandidates(snapshot, index), request = phraseRequest(snapshot, index, pool);
    try {
      const response = await run(request.state, request.questions, controller.signal);
      if (!alive.current || !modelGeneration.current.valid(token) || latest.current.version !== version || latest.current.phrases[index].locked) return;
      const candidate = pool.find(c => c.id === response.answers?.phrase?.value);
      if (!candidate) throw new Error("Jev returned a candidate outside this phrase's pool.");
      setRecommendation({ candidate, result: response, version, phrase: index, request }); setMessage(`Jev recommends “${candidate.title}”. Audition it, then accept it when you are ready.`);
    } catch (e) { if (!controller.signal.aborted && alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current && modelGeneration.current.valid(token)) setBusy(false); }
  }
  async function arrange() {
    if (!getApiKey()) { setError("Connect your Vercel AI Gateway key above to arrange a new brief. The recorded examples work without a key."); return; }
    if (score.phrases.some(p => p.locked)) { setError("Unlock all phrases before arranging a whole new score. Ask Jev about the selected unlocked phrase to preserve the rest."); return; }
    cancelRequest(); const token = modelGeneration.current.next(), originalVersion = latest.current.version, snapshot = latest.current, controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(""); setMessage("Choosing a palette, then four phrases in musical context…");
    try {
      const request = globalRequest(snapshot.brief), response = await run(request.state, request.questions, controller.signal);
      let next = blankScore(snapshot.brief, settingsFromAnswers(response.answers), snapshot.seed + 1);
      next.phrases = snapshot.phrases.map(p => ({ ...p, candidateId: "", source: "procedural", decision: undefined }));
      next.provenance = { kind: "Live Jev settings and contextual selections from procedural candidates.", decisions: [{ stage: "global", request, result: response }], edits: [] };
      for (let i = 0; i < 4; i++) {
        if (!modelGeneration.current.valid(token) || latest.current.version !== originalVersion) return;
        setMessage(`Choosing phrase ${i + 1} of 4…`);
        const pool = makeCandidates(next, i), input = phraseRequest(next, i, pool), output = await run(input.state, input.questions, controller.signal);
        const candidate = pool.find(c => c.id === output.answers?.phrase?.value); if (!candidate) throw new Error("Jev returned an unknown phrase candidate.");
        next = applyCandidate(next, i, candidate, "jev", { request: input, result: output });
      }
      if (!alive.current || !modelGeneration.current.valid(token) || latest.current.version !== originalVersion) return;
      next.version = originalVersion + 1; commit(next); setMessage("Four contextual choices are ready. Changes enter at the next bar while playing.");
    } catch (e) { if (!controller.signal.aborted && alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current && modelGeneration.current.valid(token)) setBusy(false); }
  }
  function choose(candidate: Candidate, source: "user" | "jev", decision?: unknown) {
    if (score.phrases[phrase].locked) return;
    commit(applyCandidate(latest.current, phrase, candidate, source, decision)); setMessage(`${candidate.title} selected for ${score.phrases[phrase].label.toLowerCase()}.`);
  }
  async function exportMidi() {
    try { const { Midi } = await import("@tonejs/midi"); const bytes = populateMidi(new Midi(), latest.current).toArray(); const blob = new Blob([bytes], { type: "audio/midi" }), url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = "jev-eight-bar-score.mid"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const updatePhrase = (patch: Partial<Score["phrases"][number]>) => commit({ ...score, version: score.version + 1, phrases: score.phrases.map((p,i) => i === phrase ? { ...p, ...patch } : p) });
  return <div className="ma-studio">
    <div className="ma-intro"><div><span className="ma-eyebrow">A little film. A score you can shape.</span><h2>Give the next scene a voice.</h2><p>Listen to eight bars, change a phrase, and hear the scene turn.</p></div><span className="ma-engine-tag"><Headphones size={14}/> Six synthesized instruments</span></div>
    <div className="ma-layout"><section className="ma-canvas" aria-label="Interactive score">
      <Film phrase={displayedPhrase} playing={playing}/>
      <div className="ma-transport"><div className="ma-play-buttons"><Button onClick={() => status === "idle" ? play() : stop()} aria-label={status === "idle" ? "Play arrangement" : "Stop playback"}>{status === "idle" ? <Play size={16}/> : <Square size={15}/>} {status === "starting" ? "Cancel startup" : status === "playing" ? "Stop" : "Play score"}</Button><button className="ma-icon-button" title="Reset to recorded score" aria-label="Reset to recorded score" onClick={() => { stop(); cancelRequest(); const reset = structuredClone((comparison === "jev" ? rows[rowIndex]?.score : rows[rowIndex]?.baselines?.[comparison]) ?? starterScore()); latest.current = reset; setScore(reset); setHistory([]); setSelected(""); setRecommendation(null); setMessage("Restored the starting score."); }}><RotateCcw size={17}/></button></div><div className="ma-meter"><strong>{keyName(displayedScore.settings)}</strong><span>4/4 · 8 bars</span></div><label className="ma-tempo"><span>Tempo</span><input aria-label="Tempo in beats per minute" type="number" min="50" max="180" value={score.settings.bpm} onChange={e => { const bpm = Number(e.target.value); if (bpm >= 50 && bpm <= 180) commit({ ...score, version: score.version + 1, settings: { ...score.settings, bpm } }); }}/><span>BPM</span></label></div>
      <div className="ma-play-status" aria-live="polite">{status === "starting" ? "Opening audio…" : audition ? `Auditioning ${audition}. Your score is unchanged.` : pending ? "Changes queued for the next bar. The roll shows the score currently playing." : playing ? `Playing bar ${Math.max(0, Math.floor(beat / 4)) + 1} of 8` : "Ready when you are. Audio starts only when you press Play."}</div>
      <div className="ma-scenes" role="group" aria-label="Select a two-bar phrase">{score.phrases.map((p,i) => <button key={i} className={`${phrase === i ? "selected" : ""} ${playing && displayedPhrase === i ? "playing" : ""}`} aria-pressed={phrase === i} onClick={() => { setPhrase(i); setSelected(""); setRecommendation(null); cancelRequest(); }}><span className="ma-scene-number">0{i+1}</span><strong>{p.label}</strong><small>Bars {i*2+1}–{i*2+2} · {p.source === "jev" ? "Jev choice" : p.source === "user" ? "Your edit" : "Procedural"}</small>{p.locked && <LockKeyhole size={12}/>}</button>)}</div>
      <div className="ma-chords"><span>Harmony</span>{displayedScore.chords.map(c=><span key={c.beat} title={`Notes: ${c.notes.map(noteName).join(", ")}. Inversion ${c.inversion}.`}>{c.name}</span>)}</div>
      <PianoRoll score={displayedScore} beat={playing ? beat : -1} selected={selected} onSelect={id => { const e = score.events.find(n => n.id === id); if (e) { setPhrase(e.phrase); setSelected(id); } }}/>
      <div className="ma-track-list">{score.tracks.map(track => <div className={`ma-track ${track.muted ? "is-muted" : ""}`} key={track.id} style={{ "--track-color": INSTRUMENTS[track.instrument].color } as React.CSSProperties}><button className="ma-track-mute" aria-label={`${track.muted ? "Unmute" : "Mute"} ${track.label}`} aria-pressed={track.muted} onClick={() => commit(setTrack(score, track.id, { muted: !track.muted }))}>{track.muted ? <VolumeX size={15}/> : <Volume2 size={15}/>}<span>{track.label}</span></button><div className="ma-track-events" aria-hidden="true">{displayedScore.events.filter(e => e.track === track.id && e.midi !== null).map(e=><i key={e.id} className={playing && beat >= e.beat && beat < e.beat + e.duration ? "lit" : ""} style={{ left: `${e.beat / 32 * 100}%`, width: `${Math.max(.15,e.duration / 32 * 100)}%`, top: `${((e.midi ?? 0) % 5) * 3 + 4}px` }}/>)}</div><select aria-label={`${track.label} instrument`} value={track.instrument} onChange={e => commit(setTrack(score, track.id, { instrument: e.target.value as InstrumentId }))}>{Object.entries(INSTRUMENTS).filter(([,v])=>v.role===track.id).map(([id,v])=><option key={id} value={id}>{v.name}</option>)}</select></div>)}</div>
      <div className="ma-score-footer"><span>Exact timing, pitches and durations come from one score.</span><div><button onClick={() => download("jev-eight-bar-score.json", score)}><Download size={13}/> Score JSON</button><button onClick={exportMidi}><Download size={13}/> Six-track MIDI</button></div></div>
      <div className="ma-note-editor"><div><strong>{note ? note.midi === null ? "Selected rest" : `Selected ${noteName(note.midi)}` : "Make it yours"}</strong><span>{note ? `Phrase ${note.phrase + 1} · ${note.duration} beats${score.phrases[note.phrase].locked ? " · locked" : ""}` : "Select a note in the roll to edit it. Pitch steps stay in the key."}</span></div><div className="ma-edit-actions"><button aria-label="Lower selected note one scale step" disabled={!note || note.midi===null || score.phrases[note.phrase].locked} onClick={() => note?.midi != null && commit(editNote(score, note.id, { midi: stepPitch(score.settings,note.midi,-1) }))}><ArrowDown size={16}/></button><button aria-label="Raise selected note one scale step" disabled={!note || note.midi===null || score.phrases[note.phrase].locked} onClick={() => note?.midi != null && commit(editNote(score,note.id,{midi:stepPitch(score.settings,note.midi,1)}))}><ArrowUp size={16}/></button><button disabled={!note || score.phrases[note.phrase].locked} onClick={() => note && commit(editNote(score,note.id,{midi:note.midi === null ? score.chords[note.phrase*2].notes[2] + 12 : null}))}>{note?.midi===null ? "Add note" : "Rest"}</button><select aria-label="Selected note duration in beats" disabled={!note || score.phrases[note.phrase].locked} value={note?.duration ?? 1} onChange={e => note && commit(editNote(score,note.id,{duration:Number(e.target.value)}))}>{[.125,.25,.5,.75,1,1.5,2,3,4].map(n=><option key={n} value={n}>{n} beat{n===1?"":"s"}</option>)}</select><button disabled={!history.length} onClick={() => { const previous=history.at(-1)!; setHistory(h=>h.slice(0,-1)); commit({...previous,version:score.version+1},false); }}><Undo2 size={14}/> Undo</button></div></div>
      <p className="ma-fine-print">Shorter durations leave silence before the next note. Held notes stop before the next onset. MIDI preserves notes, timing, velocity, instruments and mutes; its General MIDI sounds depend on your player.</p>
    </section><aside className="ma-sidebar">
      <section className="ma-panel"><div className="ma-panel-heading"><div><span className="ma-eyebrow">Start with a recorded arrangement</span><h3>A scene to work with</h3></div></div><Field label="Recorded brief"><select value={rows.length ? rowIndex : "starter"} onChange={e => { stop(); cancelRequest(); const i=Number(e.target.value),next=structuredClone(rows[i].score); setRowIndex(i); setComparison("jev"); latest.current=next; setScore(next); setHistory([]); setSelected(""); setRecommendation(null); setMessage(""); }} >{rows.length ? rows.map((r:any,i:number)=><option key={r.id} value={i}>{r.brief}</option>) : <option value="starter">Procedural starter · no Jev recording</option>}</select></Field>{rows[rowIndex]?.baselines && <Field label="Arrangement to compare"><select value={comparison} onChange={e => { const kind=e.target.value; stop(); cancelRequest(); setComparison(kind); const next=structuredClone(kind==="jev" ? rows[rowIndex].score : rows[rowIndex].baselines[kind]); latest.current=next; setScore(next); setHistory([]); setSelected(""); setRecommendation(null); setMessage(kind==="jev" ? "Loaded the recorded Jev selections." : kind==="rule" ? "Loaded the declared rule baseline over the same candidate generator." : "Loaded the seeded candidate-index baseline. No Jev phrase choices."); }}><option value="jev">Recorded Jev choices</option><option value="rule">Procedural rule baseline</option><option value="random">Seeded candidate baseline</option></select></Field>}<Field label="Your musical direction"><textarea rows={3} value={score.brief} onChange={e=>commit({...score,version:score.version+1,brief:e.target.value})}/></Field><Button secondary disabled={busy || score.phrases.some(p=>p.locked)} onClick={arrange}><Sparkles size={14}/>{busy ? "Jev is choosing…" : "Arrange the whole brief"}</Button><p className="ma-fine-print">Jev chooses the key, tempo, instrument palette and four phrases in sequence. Uses your connected key.</p></section>
      <section className="ma-panel ma-phrase-panel"><div className="ma-panel-heading"><div><span className="ma-eyebrow">Phrase 0{phrase+1} · bars {phrase*2+1}–{phrase*2+2}</span><h3>{score.phrases[phrase].label}</h3></div><button className={`ma-lock ${locked?"locked":""}`} aria-label={`${locked?"Unlock":"Lock"} phrase ${phrase+1}`} aria-pressed={locked} onClick={()=>updatePhrase({locked:!locked})}>{locked?<LockKeyhole size={16}/>:<LockKeyholeOpen size={16}/>} {locked?"Locked":"Lock"}</button></div><Field label="What should this phrase do?"><textarea rows={3} disabled={locked} value={score.phrases[phrase].direction} onChange={e=>updatePhrase({direction:e.target.value})}/></Field><div className="ma-contour-prefs" role="group" aria-label="Request a phrase contour">{CONTOURS.map(c=><button key={c} disabled={locked} aria-pressed={score.phrases[phrase].direction.includes(`Contour request: ${c}.`)} onClick={()=>updatePhrase({direction:score.phrases[phrase].direction.replace(/\n?Contour request: \w+\./g, "").trim()+`\nContour request: ${c}.`})}>{c}</button>)}</div><p className="ma-fine-print">A request for Jev. To guarantee a shape, choose its procedural candidate below.</p><label className="ma-tension"><span>Tension <strong>{Math.round(score.phrases[phrase].tension*100)}%</strong></span><input aria-label="Phrase tension" type="range" min="0" max="1" step=".05" disabled={locked} value={score.phrases[phrase].tension} onChange={e=>updatePhrase({tension:Number(e.target.value)})}/><small>Shapes candidate dynamics and drum density. Choose a candidate to hear it.</small></label><Button disabled={busy || locked} onClick={askJev}><Sparkles size={14}/>{busy?"Choosing a phrase…":"Ask Jev for a phrase"}</Button>{busy&&<button className="ma-text-button" onClick={()=>{cancelRequest();setMessage("Request canceled. Your score is preserved.");}}>Cancel request</button>}
      {recommendation && recommendation.phrase===phrase && <div className="ma-recommendation"><span>Jev recommends</span><strong>{recommendation.candidate.title}</strong><p>{recommendation.candidate.description}</p><Button disabled={locked || recommendation.version!==score.version} onClick={()=>choose(recommendation.candidate,"jev",{request:recommendation.request,result:recommendation.result})}>Accept phrase</Button><Fold title="Choice distribution"><Bars values={recommendation.result.answers.phrase.probabilities ?? {}} selected={recommendation.candidate.id}/><p className="ma-fine-print">These values describe the model's choice, not listener ratings.</p></Fold></div>}
      </section>
    </aside></div>
    {error&&<Notice error>{error}</Notice>}{message&&<Notice>{message}</Notice>}
    <section className="ma-candidate-section"><div className="ma-candidate-heading"><div><span className="ma-eyebrow">Procedural candidates · phrase {phrase+1}</span><h3>Six ways to carry the scene.</h3></div><p>These notes come from code. Jev selects for the brief and preceding phrase. You can choose any candidate yourself.</p></div><div className="ma-candidates">{candidates.map(c=><article key={c.id} className={score.phrases[phrase].candidateId===c.id?"selected":""}><div className="ma-candidate-title"><strong>{c.title}</strong><span>{c.contour}</span></div><MiniContour candidate={c}/><p>{c.description}</p><div><button aria-label={`Audition ${c.title}`} onClick={()=>{ const preview={...score, phrases:score.phrases.map((p,i)=>i===phrase?{...p,locked:false}:p)}; play(applyCandidate(preview,phrase,c,"user"),c.title,phrase); }}><Play size={12}/> Listen</button><button disabled={locked} onClick={()=>choose(c,"user")}>{score.phrases[phrase].candidateId===c.id?"Selected":"Use phrase"}</button></div></article>)}</div></section>
    <section className="ma-evidence"><div><strong>{rows.length} recorded arrangements</strong><span>{rows.filter((r:any)=>r.set==="original").length}/8 original briefs · {rows.filter((r:any)=>r.set==="contour").length}/6 additional contour briefs</span></div><p>Jev chooses among generated phrases using symbolic musical context. It does not hear this audio. {rows.length > 0 && `${rows.filter((r:any)=>r.set==="original").reduce((n:number,r:any)=>n+r.score.phrases.filter((p:any)=>p.contour==="arch").length,0)}/${rows.filter((r:any)=>r.set==="original").length*4} original-brief phrases use the arch shape, so selection diversity remains limited. `}Mechanical checks cover the score and MIDI; musical quality still needs independent listening.</p></section>
    <State title="Inspect this score, events and provenance" value={score}/>
    <State title="Inspect recorded inputs, candidate events and Jev decisions" value={rows[rowIndex] ?? {source:"Procedural starter",note:"No recorded model decision supplied."}}/>
  </div>;
}
