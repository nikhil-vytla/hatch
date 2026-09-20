/** Deterministic composition. No network, credentials, random globals or audio state. */
export const ENGINE_VERSION = "music-v2.1";
export const TRACK_IDS = ["melody", "answer", "keys", "pad", "bass", "drums"] as const;
export type TrackId = (typeof TRACK_IDS)[number];
export const CONTOURS = ["rising", "falling", "arch", "inverted", "breath", "syncopated"] as const;
export type Contour = (typeof CONTOURS)[number];
export const MODES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10] };
export type Mode = keyof typeof MODES;
export const TONICS: Record<string, number> = { C: 0, D: 2, F: 5, G: 7, A: 9 };
export const INSTRUMENTS = {
  flute: { name: "Air flute", program: 73, role: "melody", color: "#80d9bc" },
  bell: { name: "Glass bell", program: 10, role: "melody", color: "#80d9bc" },
  reed: { name: "Soft reed", program: 71, role: "melody", color: "#80d9bc" },
  pluck: { name: "Muted pluck", program: 24, role: "answer", color: "#baa0ed" },
  mallet: { name: "Wood mallet", program: 12, role: "answer", color: "#baa0ed" },
  piano: { name: "Electric keys", program: 4, role: "keys", color: "#eac484" },
  organ: { name: "Quiet organ", program: 16, role: "keys", color: "#eac484" },
  velvet: { name: "Velvet pad", program: 89, role: "pad", color: "#819ed9" },
  strings: { name: "Slow strings", program: 48, role: "pad", color: "#819ed9" },
  round: { name: "Round bass", program: 33, role: "bass", color: "#df99a2" },
  picked: { name: "Picked bass", program: 34, role: "bass", color: "#df99a2" },
  kit: { name: "Small drum kit", program: 0, role: "drums", color: "#9facb1" },
} as const;
export type InstrumentId = keyof typeof INSTRUMENTS;
export interface Settings { tonic: string; mode: Mode; bpm: number; palette: "acoustic" | "glass" | "nocturnal"; progression: "home" | "journey" | "suspended" }
export interface ScoreEvent { id: string; phrase: number; track: TrackId; beat: number; duration: number; midi: number | null; velocity: number; instrument: InstrumentId; articulation: "held" | "short" | "rest" }
export interface Chord { beat: number; degree: number; root: number; name: string; notes: number[]; inversion: number }
export interface Phrase { index: number; label: string; direction: string; tension: number; candidateId: string; contour: Contour; locked: boolean; source: "procedural" | "jev" | "user"; decision?: unknown }
export interface Track { id: TrackId; label: string; instrument: InstrumentId; muted: boolean }
export interface Score { engine: string; version: number; brief: string; settings: Settings; beats: 32; meter: [4, 4]; seed: number; tracks: Track[]; chords: Chord[]; phrases: Phrase[]; events: ScoreEvent[]; provenance: { kind: string; decisions: unknown[]; edits: string[] } }
export interface Candidate { id: string; contour: Contour; title: string; description: string; events: ScoreEvent[] }
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const LABELS = ["Opening", "An answer", "A change", "Coming home"];
export const noteName = (midi: number) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
export const keyName = (s: Settings) => `${s.tonic} ${s.mode}`;
export function degreePitch(settings: Settings, degree: number, octave = 4) {
  const d = ((degree % 7) + 7) % 7;
  return 12 * (octave + 1) + TONICS[settings.tonic] + MODES[settings.mode][d] + 12 * Math.floor(degree / 7);
}
export function inKey(settings: Settings, midi: number) { return MODES[settings.mode].includes(((midi - TONICS[settings.tonic]) % 12 + 12) % 12); }
export function stepPitch(settings: Settings, midi: number, direction: number) {
  let pitch = midi + direction;
  while (!inKey(settings, pitch)) pitch += direction;
  return pitch >= 55 && pitch <= 88 ? pitch : midi;
}
export function voiceChord(notes: number[], previous: number[] = [55, 60, 64]) {
  const options: { notes: number[]; cost: number; inversion: number }[] = [];
  for (let inversion = 0; inversion < 3; inversion++) {
    const rotated = [...notes.slice(inversion), ...notes.slice(0, inversion).map(n => n + 12)];
    for (const shift of [-24, -12, 0, 12]) {
      const candidate = rotated.map(n => n + shift);
      if (candidate[0] < 48 || candidate[2] > 76) continue;
      options.push({ notes: candidate, inversion, cost: candidate.reduce((sum, n, i) => sum + Math.abs(n - previous[i]), 0) });
    }
  }
  options.sort((a, b) => a.cost - b.cost || a.notes[0] - b.notes[0]);
  return options[0];
}
export function makeChords(settings: Settings): Chord[] {
  const degrees = { home: [0, 3, 5, 4, 3, 1, 4, 0], journey: [0, 5, 3, 4, 5, 3, 4, 0], suspended: [0, 1, 3, 1, 5, 3, 1, 0] }[settings.progression];
  let previous = [55 + TONICS[settings.tonic], 60 + TONICS[settings.tonic], 64 + TONICS[settings.tonic]];
  return degrees.map((degree, i) => {
    const raw = [degree, degree + 2, degree + 4].map(d => degreePitch(settings, d));
    const voiced = voiceChord(raw, previous); previous = voiced.notes;
    const root = raw[0] % 12;
    const third = raw[1] - raw[0], fifth = raw[2] - raw[0];
    const suffix = fifth === 6 ? "dim" : third === 3 ? "m" : "";
    const bass = voiced.notes[0] % 12;
    return { beat: i * 4, degree, root, notes: voiced.notes, inversion: voiced.inversion, name: `${NAMES[root]}${suffix}${bass === root ? "" : `/${NAMES[bass]}`}` };
  });
}
function instrumentBank(palette: Settings["palette"]): InstrumentId[] {
  return palette === "glass" ? ["bell", "mallet", "piano", "velvet", "round", "kit"] : palette === "nocturnal" ? ["reed", "pluck", "organ", "strings", "picked", "kit"] : ["flute", "pluck", "piano", "velvet", "round", "kit"];
}
export function globalRequest(brief: string) {
  return { state: { task: "Choose a palette for a complete 8-bar miniature. These are semantic settings; code generates the exact score.", brief, meter: "4/4", lengthBeats: 32, options: { tempo: { slow: 76, walking: 108, quick: 138 }, harmony: "All chords are diatonic to the selected tonic and mode. Home: I-IV-vi-V-IV-ii-V-I; journey: I-vi-IV-V-vi-IV-V-I; suspended: I-ii-IV-ii-vi-IV-ii-I. Roman numerals are scale degrees, quality follows the mode.", instruments: { acoustic: "Air flute, muted pluck, electric keys, velvet pad, round bass, kit", glass: "Glass bell, wood mallet, electric keys, velvet pad, round bass, kit", nocturnal: "Soft reed, muted pluck, quiet organ, slow strings, picked bass, kit" } } }, questions: {
    tonic: { type: "choice" as const, instructions: "Choose a tonic for this miniature.", criteria: Object.fromEntries(Object.keys(TONICS).map(k => [k, k])) },
    mode: { type: "choice" as const, instructions: "Choose the tonal mood that best serves the brief.", criteria: { major: "Major, clear and open", minor: "Natural minor, shadowed", dorian: "Dorian, minor with a raised sixth" } },
    tempo: { type: "choice" as const, instructions: "Choose a tempo that serves the scene.", criteria: { slow: "76 BPM, space to breathe", walking: "108 BPM, moving forward", quick: "138 BPM, restless energy" } },
    palette: { type: "choice" as const, instructions: "Choose one audible six-instrument palette.", criteria: { acoustic: "Flute and plucked answer", glass: "Bell and mallet answer", nocturnal: "Reed, organ and strings" } },
    progression: { type: "choice" as const, instructions: "Choose the harmonic journey for the eight bars.", criteria: { home: "Clear movement and return", journey: "Relative-color detour before returning", suspended: "Avoid the dominant until a gentle return" } },
  } };
}
export function settingsFromAnswers(answers: Record<string, { value: string }>): Settings {
  return { tonic: Object.hasOwn(TONICS, answers.tonic?.value) ? answers.tonic.value : "D", mode: Object.hasOwn(MODES, answers.mode?.value) ? answers.mode.value as Mode : "major", bpm: ({ slow: 76, walking: 108, quick: 138 } as Record<string, number>)[answers.tempo?.value] ?? 108, palette: ["acoustic", "glass", "nocturnal"].includes(answers.palette?.value) ? answers.palette.value as Settings["palette"] : "acoustic", progression: ["home", "journey", "suspended"].includes(answers.progression?.value) ? answers.progression.value as Settings["progression"] : "home" };
}
export function blankScore(brief = "An empty station, a light in the distance, then the warmth of coming home.", settings: Settings = { tonic: "D", mode: "major", bpm: 108, palette: "acoustic", progression: "home" }, seed = 17): Score {
  const bank = instrumentBank(settings.palette);
  return { engine: ENGINE_VERSION, version: 1, brief, settings, beats: 32, meter: [4, 4], seed, tracks: TRACK_IDS.map((id, i) => ({ id, label: ["Melody", "Answer", "Keys", "Pad", "Bass", "Drums"][i], instrument: bank[i], muted: false })), chords: makeChords(settings), phrases: LABELS.map((label, index) => ({ index, label, direction: ["Establish the scene, with room to breathe.", "Answer the opening with a contrasting shape.", "Let the tension build, without losing the motif.", "Return gently and leave a little silence."][index], tension: [0.25, 0.4, 0.8, 0.2][index], candidateId: "", contour: "arch", locked: false, source: "procedural" })), events: [], provenance: { kind: "Procedural starter. No Jev decision has been made.", decisions: [], edits: [] } };
}
const RHYTHMS: Record<Contour, number[]> = {
  rising: [1, 0.5, 0.5, 1, 1, 1, 1, 2],
  falling: [1.5, 0.5, 1, 1, 1, 1, 1, 1],
  arch: [1, 1, 0.5, 0.5, 1, 1, 1, 2],
  inverted: [1, 1, 1, 1, 0.5, 0.5, 1, 2],
  breath: [1.5, 0.5, 1, 1, 1.5, 0.5, 1, 1],
  syncopated: [0.5, 1, 0.5, 1.5, 0.5, 0.5, 1, 0.5, 1, 1],
};
const SHAPES: Record<Contour, number[]> = {
  rising: [0, 0, 1, 2, 3, 4, 4, 5], falling: [6, 6, 5, 4, 3, 2, 1, 0], arch: [0, 2, 3, 5, 4, 3, 1, 0], inverted: [5, 3, 2, 0, 1, 2, 4, 5], breath: [0, 2, 3, 2, 1, 0, 2, 0], syncopated: [0, 2, 1, 4, 3, 2, 4, 3, 1, 0],
};
const DESCRIPTIONS: Record<Contour, string> = { rising: "A measured climb. Short pickups lead to a held high note.", falling: "A descending answer. Settles step by step into its lower register.", arch: "Rises toward a peak, then returns with a longer final note.", inverted: "Dips into a valley, then lifts back into the upper register.", breath: "Two small gestures with space between them and a rest at the end.", syncopated: "Offbeat attacks and short rests break up the pulse." };
function event(score: Score, phrase: number, track: TrackId, beat: number, duration: number, midi: number | null, velocity: number, suffix: string): ScoreEvent {
  return { id: `${phrase}-${track}-${suffix}`, phrase, track, beat, duration, midi, velocity: midi === null ? 0 : velocity, instrument: score.tracks.find(t => t.id === track)!.instrument, articulation: midi === null ? "rest" : duration >= 1 ? "held" : "short" };
}
function accompaniment(score: Score, index: number): ScoreEvent[] {
  const result: ScoreEvent[] = [], tension = score.phrases[index].tension;
  for (let localBar = 0; localBar < 2; localBar++) {
    const chord = score.chords[index * 2 + localBar], beat = chord.beat;
    chord.notes.forEach((pitch, j) => {
      result.push(event(score, index, "pad", beat, 4, pitch, 0.27 + tension * 0.08, `${localBar}-${j}`));
      for (const offset of [0, 2]) result.push(event(score, index, "keys", beat + offset, 1.5, pitch + (j === 2 ? 0 : 0), 0.39 + tension * 0.1, `${localBar}-${offset}-${j}`));
    });
    const bass = 36 + chord.root;
    result.push(event(score, index, "bass", beat, 1.75, bass, 0.64, `${localBar}-0`), event(score, index, "bass", beat + 2, 1.75, bass + (tension > 0.6 ? 7 : 0), 0.58, `${localBar}-2`));
    // Bass fifth remains diatonic even over a diminished chord.
    const last = result[result.length - 1];
    if (!inKey(score.settings, last.midi!)) last.midi = bass;
    if (index !== 0 || localBar === 1) {
      result.push(event(score, index, "answer", beat + 1.5, 0.5, chord.notes[2] + 12, 0.43, `${localBar}-a`), event(score, index, "answer", beat + 3, 0.75, chord.notes[1] + 12, 0.4, `${localBar}-b`));
    }
    for (const offset of [0, 2]) result.push(event(score, index, "drums", beat + offset, 0.25, 36, 0.54, `${localBar}-kick-${offset}`));
    for (const offset of [1, 3]) result.push(event(score, index, "drums", beat + offset, 0.25, 38, 0.32, `${localBar}-snare-${offset}`));
    for (let offset = 0.5; offset < 4; offset += tension > 0.55 ? 0.5 : 1) result.push(event(score, index, "drums", beat + offset, 0.125, 42, 0.22 + (offset % 1 ? 0 : 0.06), `${localBar}-hat-${offset}`));
  }
  return result;
}
export function makeCandidates(score: Score, index: number): Candidate[] {
  const phrase = score.phrases[index], previous = score.events.filter(e => e.track === "melody" && e.phrase === index - 1 && e.midi !== null).at(-1)?.midi;
  const chord = score.chords[index * 2];
  // Shift the whole contour by a diatonic amount. No independent note prediction.
  const base = chord.degree + ((score.seed + index) % 2 === 0 ? 0 : 2);
  return CONTOURS.map((contour, ci) => {
    const shape = SHAPES[contour], rhythm = RHYTHMS[contour];
    let pitches = shape.map(d => degreePitch(score.settings, base + d));
    // Pick a shared octave that keeps the phrase near the previous ending.
    if (previous != null && Math.abs(pitches[0] - 12 - previous) < Math.abs(pitches[0] - previous) && Math.min(...pitches) - 12 >= 55) pitches = pitches.map(n => n - 12);
    while (Math.max(...pitches) > 88) pitches = pitches.map(n => n - 12);
    let beat = index * 8;
    const melody = rhythm.map((duration, j) => {
      const rest = (contour === "breath" && [3, 7].includes(j)) || (contour === "syncopated" && [0, 5].includes(j));
      const e = event(score, index, "melody", beat, duration, rest ? null : pitches[j], 0.64 + phrase.tension * 0.12 + (j % 2 === 0 ? 0.03 : -0.03), `${j}`);
      beat += duration;
      return e;
    });
    return { id: `p${index}-${score.seed}-${ci}`, contour, title: { rising: "Lift", falling: "Settle", arch: "Reach & return", inverted: "Dip & rise", breath: "Leave a breath", syncopated: "Find the offbeat" }[contour], description: DESCRIPTIONS[contour], events: [...melody, ...accompaniment(score, index)].sort((a, b) => a.beat - b.beat || a.track.localeCompare(b.track) || (a.midi ?? -1) - (b.midi ?? -1)) };
  });
}
export function phraseRequest(score: Score, index: number, candidates = makeCandidates(score, index)) {
  return { state: { task: "Choose one complete, procedural two-bar phrase by how well it expresses the scene. You select from valid candidates; you do not generate the notes. No audio is provided.", engine: ENGINE_VERSION, brief: score.brief, scoreVersion: score.version, settings: score.settings, phrase: (({ decision, ...semantic }) => semantic)(score.phrases[index]), history: score.phrases.slice(0, index).map(({ decision, ...semantic }) => semantic), previousPhraseEvents: score.events.filter(e => e.phrase === index - 1), harmony: score.chords.filter(c => c.beat >= index * 8 && c.beat < (index + 1) * 8), tracks: score.tracks, candidateEncoding: "Each candidate contains melody events. sharedAccompaniment supplies the identical remaining five tracks for every candidate; combine both event lists to recover the full candidate.", sharedAccompaniment: candidates[0].events.filter(e => e.track !== "melody"), candidates: candidates.map(c => ({ ...c, events: c.events.filter(e => e.track === "melody") })) }, questions: { phrase: { type: "choice" as const, instructions: "Choose the candidate that best follows the requested direction and tension while making a coherent continuation of the supplied previous phrase. Consider the actual pitch, duration and rest events. Prefer explicit contour requests when present. These candidates have equal playback gain. Confidence is not listener preference.", criteria: Object.fromEntries(candidates.map(c => [c.id, `${c.title}: ${c.contour}. ${c.description}`])) } } };
}
export function applyCandidate(score: Score, index: number, candidate: Candidate, source: Phrase["source"], decision?: unknown): Score {
  if (score.phrases[index].locked) return score;
  return { ...score, version: score.version + 1, phrases: score.phrases.map((p, i) => i === index ? { ...p, candidateId: candidate.id, contour: candidate.contour, source, decision } : p), events: [...score.events.filter(e => e.phrase !== index), ...candidate.events].sort((a, b) => a.beat - b.beat || a.id.localeCompare(b.id)), provenance: { ...score.provenance, decisions: decision ? [...score.provenance.decisions, decision] : score.provenance.decisions, edits: source === "user" ? [...score.provenance.edits, `Selected ${candidate.contour} for phrase ${index + 1}`] : score.provenance.edits } };
}
export function starterScore(brief?: string, settings?: Settings, seed = 17): Score {
  let score = blankScore(brief, settings, seed);
  const selections = [2, 1, 5, 4];
  for (let i = 0; i < 4; i++) score = applyCandidate(score, i, makeCandidates(score, i)[selections[i]], "procedural");
  return score;
}
export function editNote(score: Score, id: string, patch: Partial<Pick<ScoreEvent, "midi" | "duration">>): Score {
  const note = score.events.find(e => e.id === id);
  if (!note || note.track !== "melody" || score.phrases[note.phrase].locked) return score;
  const next = score.events.filter(e => e.track === "melody" && e.phrase === note.phrase && e.beat > note.beat).sort((a, b) => a.beat - b.beat)[0];
  const maximum = (next?.beat ?? (note.phrase + 1) * 8) - note.beat;
  const duration = Math.max(0.125, Math.min(patch.duration ?? note.duration, maximum));
  const midi = patch.midi === undefined ? note.midi : patch.midi;
  return { ...score, version: score.version + 1, events: score.events.map(e => e.id === id ? { ...e, midi, duration, velocity: midi === null ? 0 : e.velocity || 0.7, articulation: midi === null ? "rest" : duration >= 1 ? "held" : "short" } : e), phrases: score.phrases.map((p, i) => i === note.phrase ? { ...p, source: "user" } : p), provenance: { ...score.provenance, edits: [...score.provenance.edits, `Edited ${id}: pitch ${midi ?? "rest"}, duration ${duration} beats`] } };
}
export function setTrack(score: Score, track: TrackId, patch: Partial<Pick<Track, "muted" | "instrument">>): Score {
  return { ...score, version: score.version + 1, tracks: score.tracks.map(t => t.id === track ? { ...t, ...patch } : t), events: patch.instrument ? score.events.map(e => e.track === track ? { ...e, instrument: patch.instrument! } : e) : score.events, provenance: { ...score.provenance, edits: [...score.provenance.edits, `${track}: ${JSON.stringify(patch)}`] } };
}
export function playbackEvents(score: Score) {
  const muted = new Set(score.tracks.filter(t => t.muted).map(t => t.id));
  return score.events.filter((e): e is ScoreEvent & { midi: number } => e.midi !== null && !muted.has(e.track));
}
export function validateScore(score: Score): string[] {
  const errors: string[] = [], ids = new Set<string>();
  if (score.beats !== 32 || score.meter.join() !== "4,4") errors.push("Expected eight bars of 4/4");
  for (const e of score.events) {
    if (ids.has(e.id)) errors.push(`Duplicate ID ${e.id}`); ids.add(e.id);
    if (!(e.duration > 0 && e.beat >= 0 && e.beat + e.duration <= 32 && e.beat >= e.phrase * 8 && e.beat + e.duration <= (e.phrase + 1) * 8)) errors.push(`Invalid span ${e.id}`);
    if (e.midi !== null && (!Number.isInteger(e.midi) || e.midi < 0 || e.midi > 127)) errors.push(`Invalid pitch ${e.id}`);
    if (e.midi !== null && e.track !== "drums" && !inKey(score.settings, e.midi)) errors.push(`Out of key ${e.id}`);
    if (!Number.isFinite(e.velocity) || e.velocity < 0 || e.velocity > 1) errors.push(`Invalid velocity ${e.id}`);
    if (e.instrument !== score.tracks.find(t => t.id === e.track)?.instrument) errors.push(`Instrument mismatch ${e.id}`);
  }
  for (const p of score.phrases) {
    const notes = score.events.filter(e => e.phrase === p.index && e.track === "melody").sort((a, b) => a.beat - b.beat);
    for (let i = 1; i < notes.length; i++) if (notes[i - 1].beat + notes[i - 1].duration > notes[i].beat) errors.push(`Melody overlap ${notes[i].id}`);
  }
  return errors;
}
/** Both Tone playback and MIDI use playbackEvents. MIDI mute/export parity is intentional. */
export function populateMidi(midi: any, score: Score) {
  midi.header.name = `${score.brief} | ${ENGINE_VERSION}`;
  midi.header.setTempo(score.settings.bpm);
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: [4, 4] }];
  for (const [i, track] of score.tracks.entries()) {
    const t = midi.addTrack(); t.name = `${track.label} · ${INSTRUMENTS[track.instrument].name}${track.muted ? " (muted)" : ""}`;
    t.channel = track.id === "drums" ? 9 : i; t.instrument.number = INSTRUMENTS[track.instrument].program;
    for (const e of playbackEvents(score).filter(e => e.track === track.id)) t.addNote({ midi: e.midi, ticks: Math.round(e.beat * midi.header.ppq), durationTicks: Math.round(e.duration * midi.header.ppq), velocity: e.velocity });
    t.endOfTrackTicks = score.beats * midi.header.ppq;
  }
  return midi;
}
/** Isolated clock state used by the actual audio scheduler and tested without a browser. */
export class BarScore {
  current: Score;
  pending: Score | null = null;
  constructor(score: Score) { this.current = score; }
  queue(score: Score) { this.pending = score; }
  atBeat(beat: number) { if (beat % 4 === 0 && this.pending) { this.current = this.pending; this.pending = null; } return this.current; }
}
export class Generation {
  private value = 0;
  next() { return ++this.value; }
  valid(token: number) { return token === this.value; }
}
