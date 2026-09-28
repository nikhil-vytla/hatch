import { expect, test } from "bun:test";
import { materialFrames } from "./frames";

function fixture() {
  let serial = 0,
    steps = 0,
    draws = 0,
    publications = 0;
  const waiting = new Map<number, FrameRequestCallback>();
  const clock = materialFrames({
    request(callback) {
      waiting.set(++serial, callback);
      return serial;
    },
    cancel(id) {
      waiting.delete(id);
    },
    step() {
      steps++;
    },
    draw() {
      draws++;
    },
    publish() {
      publications++;
    },
  });
  return {
    clock,
    waiting,
    counts: () => ({ steps, draws, publications }),
    frame(now: number) {
      const [id, callback] = waiting.entries().next().value!;
      waiting.delete(id);
      callback(now);
    },
  };
}

test("a paused scene draws once on demand and never schedules an idle loop", () => {
  const f = fixture();
  expect(f.waiting.size).toBe(0);
  f.clock.setVisible(true);
  expect(f.waiting.size).toBe(1);
  f.frame(0);
  expect(f.counts()).toEqual({ steps: 0, draws: 1, publications: 0 });
  expect(f.waiting.size).toBe(0);
  f.clock.invalidate();
  f.clock.invalidate();
  f.clock.invalidate();
  expect(f.waiting.size).toBe(1);
  f.frame(10);
  expect(f.counts().draws).toBe(2);
  expect(f.waiting.size).toBe(0);
});

test("playing keeps the 40 ms tick without redrawing unchanged frames", () => {
  const f = fixture();
  f.clock.setPlaying(true);
  f.clock.setVisible(true);
  f.frame(0);
  f.frame(16);
  f.frame(32);
  expect(f.counts().steps).toBe(0);
  expect(f.counts().draws).toBe(1);
  f.frame(48);
  expect(f.counts().steps).toBe(1);
  expect(f.counts().draws).toBe(2);
  f.clock.setPlaying(false);
  expect(f.waiting.size).toBe(0);
});

test("offscreen and hidden scenes cancel work, retain edits and do not catch up", () => {
  for (const gate of ["setVisible", "setPageVisible"] as const) {
    const f = fixture();
    f.clock.setVisible(true);
    f.clock.setPlaying(true);
    f.frame(100);
    f.frame(140);
    expect(f.counts().steps).toBe(1);
    f.clock[gate](false);
    expect(f.waiting.size).toBe(0);
    f.clock.invalidate();
    f.clock.invalidate();
    expect(f.waiting.size).toBe(0);
    f.clock[gate](true);
    f.frame(50_000);
    expect(f.counts().steps).toBe(1);
    f.frame(50_040);
    expect(f.counts().steps).toBe(2);
    f.clock.dispose();
    expect(f.waiting.size).toBe(0);
  }
});

test("returning to a paused scene refreshes its picture once without resuming", () => {
  const f = fixture();
  f.clock.setVisible(true);
  f.frame(0);
  f.clock.setVisible(false);
  f.clock.invalidate();
  f.clock.setVisible(true);
  f.frame(1000);
  expect(f.counts()).toEqual({ steps: 0, draws: 2, publications: 0 });
  expect(f.waiting.size).toBe(0);
});

test("unmount cancels and makes captured callbacks inert", () => {
  const f = fixture();
  f.clock.setPlaying(true);
  f.clock.setVisible(true);
  const callback = [...f.waiting.values()][0];
  f.clock.dispose();
  callback(500);
  f.clock.invalidate();
  f.clock.setVisible(false);
  f.clock.setVisible(true);
  f.clock.setPlaying(true);
  expect(f.counts()).toEqual({ steps: 0, draws: 0, publications: 0 });
  expect(f.waiting.size).toBe(0);
});

test("pausing discards fractional timing rather than advancing the next explicit run", () => {
  const f = fixture();
  f.clock.setPlaying(true);
  f.clock.setVisible(true);
  f.frame(0);
  f.frame(30);
  f.clock.setPlaying(false);
  f.clock.setPlaying(true);
  f.frame(1000);
  f.frame(1010);
  expect(f.counts().steps).toBe(0);
  f.frame(1040);
  expect(f.counts().steps).toBe(1);
  f.clock.dispose();
});
