import { expect, test } from "bun:test";
import { makeAudio } from "../experience-prototypes/src/music-arranger";
import { starterScore, playbackEvents, setTrack } from "./engine";
function fakeAudio() {
  const triggers: any[] = [], nodes: any[] = []; let clock: any;
  class Node {
    id = nodes.length; disposed = false; maxPolyphony = 0;
    constructor(..._args: any[]) { nodes.push(this); }
    toDestination() { return this; } connect(_destination: any) { return this; } disconnect() { return this; }
    dispose() { this.disposed = true; }
    triggerAttackRelease(...args: any[]) { triggers.push({ node: this.id, args }); }
  }
  class Clock extends Node {
    frequency = { setValueAtTime: (_value: number, _time: number) => {} };
    constructor(public callback: (time: number) => void, _frequency: number) { super(); clock = this; }
    start(_time: number) {} stop() {}
  }
  const tone = { Limiter: Node, Volume: Node, PolySynth: Node, Synth: Node, FMSynth: Node, MembraneSynth: Node, NoiseSynth: Node, Filter: Node, Clock, Frequency: (midi: number) => ({ toFrequency: () => midi }), getDraw: () => ({ schedule: (fn: () => void, _time: number) => fn() }), now: () => 0 };
  return { tone, triggers, nodes, get clock() { return clock; } };
}
test("actual audio adapter schedules every canonical event at the exact onset, duration and velocity", () => {
  const fake = fakeAudio(), score = starterScore(); let draws = 0;
  const engine = makeAudio(fake.tone as any, score, () => draws++, () => true);
  for (let tick = 0; tick < 256; tick++) fake.clock.callback(tick / 8 * 60 / score.settings.bpm);
  const expected = playbackEvents(score);
  expect(fake.triggers.length).toBe(expected.length); expect(draws).toBe(256);
  const instrumentNodes = { flute: 2, bell: 4, reed: 3, pluck: 5, mallet: 6, piano: 7, organ: 8, velvet: 9, strings: 10, round: 11, picked: 12, kit: 13 };
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i], actual = fake.triggers[i];
    if (e.track === "drums" && e.midi !== 36) {
      expect(actual.node).toBe(e.midi === 38 ? 14 : 15);
      expect(actual.args[0]).toBeCloseTo(e.duration * 60 / score.settings.bpm, 8);
      expect(actual.args[1]).toBeCloseTo(e.beat * 60 / score.settings.bpm, 8);
      expect(actual.args[2]).toBe(e.velocity);
    } else {
      expect(actual.node).toBe(instrumentNodes[e.instrument]); expect(actual.args[0]).toBe(e.midi);
      expect(actual.args[1]).toBeCloseTo(e.duration * 60 / score.settings.bpm, 8);
      expect(actual.args[2]).toBeCloseTo(e.beat * 60 / score.settings.bpm, 8);
      expect(actual.args[3]).toBe(e.velocity);
    }
  }
  engine.dispose(); expect(fake.nodes.every(n => n.disposed)).toBe(true);
  const count = fake.triggers.length; fake.clock.callback(100); expect(fake.triggers.length).toBe(count);
});
test("actual scheduler applies queued mute at a bar and rejects stale generation ticks", () => {
  const fake = fakeAudio(), score = starterScore(); let valid = true;
  const engine = makeAudio(fake.tone as any, score, () => {}, () => valid);
  fake.clock.callback(0); engine.box.queue(setTrack(score, "bass", { muted: true }));
  for (let tick = 1; tick < 32; tick++) fake.clock.callback(tick / 8);
  expect(engine.box.current.tracks.find(t => t.id === "bass")!.muted).toBe(false);
  fake.clock.callback(4); expect(engine.box.current.tracks.find(t => t.id === "bass")!.muted).toBe(true);
  valid = false; const count = fake.triggers.length; fake.clock.callback(5); expect(fake.triggers.length).toBe(count); engine.dispose();
});
