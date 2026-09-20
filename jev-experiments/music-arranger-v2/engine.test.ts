import { describe, test, expect } from "bun:test";
import { createRequire } from "node:module";
import { CONTOURS, MODES, TONICS, INSTRUMENTS, starterScore, blankScore, makeCandidates, applyCandidate, validateScore, playbackEvents, populateMidi, editNote, setTrack, Generation, BarScore, phraseRequest, globalRequest, voiceChord, type Settings } from "./engine";
import { validate } from "../experience-prototypes/server/gateway";
const appRequire = createRequire(new URL("../experience-prototypes/package.json", import.meta.url));
const { Midi } = appRequire("@tonejs/midi");
describe("canonical score", () => {
  test("all tonic/mode/progression combinations and six contours satisfy timing, range and harmony constraints", () => {
    for (const tonic of Object.keys(TONICS)) for (const mode of Object.keys(MODES) as Settings["mode"][]) for (const progression of ["home", "journey", "suspended"] as const) {
      let score = blankScore("test", { tonic, mode, progression, palette: "acoustic", bpm: 108 }, 21);
      for (let phrase = 0; phrase < 4; phrase++) {
        const candidates = makeCandidates(score, phrase);
        for (const candidate of candidates) {
          const rendered = applyCandidate(score, phrase, candidate, "procedural");
          expect(validateScore(rendered)).toEqual([]);
          expect(candidate.events.filter(e => e.track === "melody").reduce((a, e) => a + e.duration, 0)).toBe(8);
          expect(candidate.events.filter(e => e.track === "melody" && e.midi !== null).every(e => e.midi! >= 55 && e.midi! <= 88)).toBe(true);
        }
        score = applyCandidate(score, phrase, candidates[phrase], "procedural");
      }
    }
  });
  test("contours, rests and syncopation describe the actual events", () => {
    const candidates = makeCandidates(starterScore(), 1);
    const pitches = (i: number) => candidates[i].events.filter(e => e.track === "melody" && e.midi !== null).map(e => e.midi!);
    const rises = pitches(0); expect(rises.at(-1)!).toBeGreaterThan(rises[0]); expect(rises.every((n, i) => i === 0 || n >= rises[i - 1])).toBe(true);
    const falls = pitches(1); expect(falls.at(-1)!).toBeLessThan(falls[0]); expect(falls.every((n, i) => i === 0 || n <= falls[i - 1])).toBe(true);
    expect(Math.max(...pitches(2))).toBeGreaterThan(Math.max(pitches(2)[0], pitches(2).at(-1)!));
    expect(Math.min(...pitches(3))).toBeLessThan(Math.min(pitches(3)[0], pitches(3).at(-1)!));
    const breath = candidates[4].events.filter(e => e.track === "melody"); expect(breath.at(-1)?.midi).toBeNull(); expect(breath.filter(e => e.midi === null)).toHaveLength(2);
    expect(candidates[5].events.some(e => e.track === "melody" && e.midi !== null && e.beat % 1 === 0.5)).toBe(true);
  });
  test("voice leading chooses a minimum-cost allowed inversion", () => {
    const result = voiceChord([60, 64, 67], [59, 62, 67]);
    expect(result.notes).toEqual([60, 64, 67]); expect(result.cost).toBe(3);
  });
  test("score generation is deterministic, all requests fit the shared gateway schema", () => {
    const s = starterScore(); expect(starterScore()).toEqual(s); validate(globalRequest(s.brief));
    for (let i = 0; i < 4; i++) { const request = phraseRequest(s, i); validate(request); expect(JSON.stringify(request).length).toBeLessThan(100000); expect(request.state.previousPhraseEvents.every(e => e.phrase === i - 1)).toBe(true); }
  });
  test("MIDI round trip preserves all six tracks, pitches, start/duration ticks and velocities", () => {
    for (const palette of ["acoustic", "glass", "nocturnal"] as const) for (const bpm of [76, 108, 138]) {
      const score = starterScore("parity", { tonic: "D", mode: "minor", progression: "journey", palette, bpm });
      const written = populateMidi(new Midi(), score), parsed = new Midi(written.toArray());
      expect(parsed.tracks.length).toBe(6); expect(parsed.header.tempos[0].bpm).toBeCloseTo(bpm, 3);
      for (let i = 0; i < 6; i++) {
        const expected = playbackEvents(score).filter(e => e.track === score.tracks[i].id).sort((a, b) => a.beat - b.beat || a.midi - b.midi);
        const actual = parsed.tracks[i].notes.sort((a: any, b: any) => a.ticks - b.ticks || a.midi - b.midi);
        expect(actual.length).toBe(expected.length); expect(parsed.tracks[i].channel).toBe(i === 5 ? 9 : i);
        expect(parsed.tracks[i].instrument.number).toBe(INSTRUMENTS[score.tracks[i].instrument].program);
        for (let n = 0; n < expected.length; n++) {
          expect(actual[n].midi).toBe(expected[n].midi);
          expect(Math.abs(actual[n].ticks - expected[n].beat * parsed.header.ppq)).toBeLessThanOrEqual(1);
          expect(Math.abs(actual[n].durationTicks - expected[n].duration * parsed.header.ppq)).toBeLessThanOrEqual(1);
          expect(Math.abs(actual[n].velocity - expected[n].velocity)).toBeLessThanOrEqual(1 / 127);
        }
      }
    }
  });
  test("rests, edits, mute and instrument changes survive canonical export", () => {
    let s = starterScore(); const id = s.events.find(e => e.track === "melody" && e.midi !== null)!.id;
    s = editNote(s, id, { midi: null }); expect(playbackEvents(s).some(e => e.id === id)).toBe(false);
    s = setTrack(s, "answer", { muted: true }); expect(playbackEvents(s).some(e => e.track === "answer")).toBe(false);
    s = setTrack(s, "melody", { instrument: "reed" }); expect(s.events.filter(e => e.track === "melody").every(e => e.instrument === "reed")).toBe(true);
    const m = new Midi(populateMidi(new Midi(), s).toArray()); expect(m.tracks.flatMap((t: any) => t.notes).length).toBe(playbackEvents(s).length);
    const note = s.events.find(e => e.id === id)!; s = editNote(s, id, { duration: 100, midi: 62 }); expect(s.events.find(e => e.id === id)!.duration).toBeLessThanOrEqual(8 - note.beat); expect(validateScore(s)).toEqual([]);
  });
  test("phrase locks reject model and user replacements", () => {
    const s = starterScore(); s.phrases[1].locked = true;
    for (const source of ["jev", "user", "procedural"] as const) expect(applyCandidate(s, 1, makeCandidates(s, 1)[0], source)).toBe(s);
    expect(editNote(s, s.events.find(e => e.phrase === 1 && e.track === "melody")!.id, { midi: null })).toBe(s);
  });
});
describe("scheduler state", () => {
  test("only a bar boundary adopts the latest queued score", () => {
    const s = starterScore(), bar = new BarScore(s), next = setTrack(s, "bass", { muted: true });
    bar.queue(next); for (let beat = 0.125; beat < 4; beat += 0.125) expect(bar.atBeat(beat)).toBe(s);
    expect(bar.atBeat(4)).toBe(next); expect(bar.pending).toBeNull();
  });
  test("stop and subsequent starts invalidate every stale asynchronous continuation", async () => {
    const generation = new Generation(), old = generation.next(); let started = false;
    const continuation = Promise.resolve().then(() => { if (generation.valid(old)) started = true; });
    generation.next(); await continuation; expect(started).toBe(false);
    const fresh = generation.next(); expect(generation.valid(fresh)).toBe(true); expect(generation.valid(old)).toBe(false);
  });
});
