import { test, expect } from "bun:test";
import {
  createWorld,
  createPair,
  advance,
  STEP,
  copy,
  checkpoint,
  forkPair,
  compareJev,
  setController,
  setNotice,
  issueTicket,
  applyReply,
  humanTarget,
  PLACES,
  questions,
  observation,
  type World,
  type Ticket,
} from "./engine";
const step = (w: World, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / STEP); i++) advance(w);
};
function reply(t: Ticket, target = "library") {
  return Object.fromEntries(
    Object.keys(t.actors).flatMap((id) => [
      [`destination_${id}`, { type: "choice", value: target }],
      [`reaction_${id}`, { type: "choice", value: "drawn_in" }],
    ]),
  );
}
test("same seed gives synchronized disturbances even with different destinations", () => {
  const a = createWorld(27, "a"),
    b = copy(a);
  b.id = "b";
  setController(b, "notice");
  setNotice(b, "Everyone who likes music, meet at the tiny stage.");
  step(a, 500);
  step(b, 500);
  expect(a.disturbances).toEqual(b.disturbances);
  expect(a.rng).toBe(b.rng);
  expect(a.weather).toBe(b.weather);
  expect(a.eventCursor).toBe(b.eventCursor);
  expect(a.tick).toBe(b.tick);
  expect(a.residents.map((r) => r.memory)).not.toEqual(
    b.residents.map((r) => r.memory),
  );
});
test("world continues under a pending model request; moving-state change is valid", () => {
  const w = createWorld();
  setController(w, "jev", true);
  const t = issueTicket(w),
    before = copy(w);
  step(w, 0.4);
  expect(w.time).toBeGreaterThan(before.time);
  expect(w.residents[0].x).not.toBe(before.residents[0].x);
  const out = applyReply(w, t, reply(t));
  expect(out.accepted).toBeGreaterThan(0);
  expect(out.stale).toBe(0);
  expect(w.metrics.jevAccepted).toBe(out.accepted);
});
test("human intervention rejects only that actor, preserving other valid answers", () => {
  const w = createWorld();
  setController(w, "jev", true);
  const t = issueTicket(w);
  humanTarget(w, "r0", "garden");
  const result = applyReply(w, t, reply(t));
  expect(result.stale).toBe(1);
  expect(result.accepted).toBe(11);
  expect(w.residents[0].target).toBe("garden");
  expect(w.residents[0].source).toBe("human");
});
test("notice changes, expiry and forks invalidate replies independently of positions", () => {
  for (const reason of ["notice", "expiry", "fork"]) {
    const w = createWorld();
    setController(w, "jev");
    const t = issueTicket(w);
    if (reason === "notice") setNotice(w, "New announcement");
    if (reason === "expiry") step(w, 19);
    if (reason === "fork") {
      w.id = "other";
      w.epoch++;
    }
    expect(applyReply(w, t, reply(t)).accepted).toBe(0);
  }
});
test("closed or malformed destinations cannot be applied", () => {
  const w = createWorld();
  setController(w, "jev");
  w.weather = "rain";
  const t = issueTicket(w);
  expect(applyReply(w, t, reply(t, "stage")).illegal).toBe(12);
  const t2 = issueTicket(w);
  expect(applyReply(w, t2, reply(t2, "constructor")).illegal).toBe(12);
  expect(w.metrics.jevAccepted).toBe(0);
});
test("restore preserves complete action memory, settings, decisions and deterministic future", () => {
  const p = createPair();
  setController(p.a, "jev", false);
  setController(p.b, "notice");
  const t = issueTicket(p.a);
  applyReply(p.a, t, reply(t, "bakery"));
  step(p.a, 41);
  step(p.b, 41);
  const c = checkpoint(p),
    fork = forkPair(c, "fork", "Alternate");
  expect(fork.a.controller).toBe("jev");
  expect(fork.a.assisted).toBe(false);
  expect(fork.a.decisions).toEqual(p.a.decisions);
  expect(fork.a.residents).toEqual(p.a.residents);
  expect(fork.a.rng).toBe(p.a.rng);
  const original = copy(p.a);
  step(original, 50);
  step(fork.a, 50);
  expect(fork.a.residents).toEqual(original.residents);
  expect(fork.a.disturbances).toEqual(original.disturbances);
  expect(c.pair.a.time).toBe(41);
});
test("paired Jev comparison differs only by identity and fallback setting initially", () => {
  const p = createPair();
  step(p.a, 10);
  step(p.b, 10);
  const compare = compareJev(checkpoint(p), "comparison");
  expect(compare.a.residents).toEqual(compare.b.residents);
  expect(compare.a.rng).toBe(compare.b.rng);
  expect(compare.a.controller).toBe("jev");
  expect(compare.b.controller).toBe("jev");
  expect(compare.a.assisted).toBe(false);
  expect(compare.b.assisted).toBe(true);
  step(compare.a, 100);
  step(compare.b, 100);
  expect(compare.a.metrics.fallbackChoices).toBe(0);
  expect(compare.b.metrics.fallbackChoices).toBeGreaterThan(0);
  expect(compare.a.metrics.waitingActorSeconds).toBeGreaterThan(0);
  expect(compare.a.time).toBe(compare.b.time);
});
test("Jev targets remain attributed to Jev during deterministic actuation", () => {
  const w = createWorld();
  setController(w, "jev", true);
  const t = issueTicket(w);
  applyReply(w, t, reply(t, "library"));
  step(w, 1);
  expect(w.residents.every((r) => r.source === "jev")).toBe(true);
  expect(w.metrics.fallbackChoices).toBe(0);
  expect(w.metrics.fallbackActorSeconds).toBe(0);
});
test("queues never exceed capacity; all needs stay bounded during long play", () => {
  const w = createWorld();
  setController(w, "notice");
  setNotice(w, "Music and singing at the stage.");
  for (let i = 0; i < 180 / STEP; i++) {
    advance(w);
    for (const p of PLACES)
      expect(
        w.residents.filter((r) => r.target === p.id && r.phase === "visiting")
          .length,
      ).toBeLessThanOrEqual(p.capacity);
  }
  for (const r of w.residents)
    for (const v of Object.values(r.needs)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  expect(w.metrics.visits).toBeGreaterThan(10);
});
test("request shape excludes hidden schedule, RNG, key and future labels", () => {
  const w = createWorld();
  setController(w, "jev");
  const t = issueTicket(w),
    o = observation(w, t),
    q = questions(t);
  expect(Object.keys(q)).toHaveLength(24);
  const text = JSON.stringify(o);
  for (const hidden of [
    "disturbances",
    "rng",
    "apiKey",
    "secret",
    "eventCursor",
  ])
    expect(text.includes(hidden)).toBe(false);
  expect(o.residents).toHaveLength(12);
  expect(q.destination_r0).toBeDefined();
});
test("a newly started visit is a changed action precondition", () => {
  const w = createWorld();
  setController(w, "jev");
  const t = issueTicket(w);
  w.residents[0].phase = "visiting";
  w.residents[0].serviceLeft = 10;
  const result = applyReply(w, t, reply(t));
  expect(result.stale).toBe(1);
  expect(result.accepted).toBe(11);
});
import demo from "./demo.json";
import { replayPlan } from "./engine";
test("recorded plan replay uses exact observed state and same genuine decisions in both lanes", () => {
  const snapshot = demo.result.snapshot as unknown as World;
  expect(observation(snapshot, demo.result.ticket)).toEqual(
    demo.result.request.state,
  );
  expect(questions(demo.result.ticket)).toEqual(demo.result.request.questions);
  const p = replayPlan(
    snapshot,
    demo.result.ticket,
    demo.result.response.answers,
    "demo-test",
  );
  expect(p.a.residents).toEqual(p.b.residents);
  expect(p.a.metrics.recordedAccepted).toBe(12);
  expect(p.b.metrics.recordedAccepted).toBe(12);
  expect(p.a.metrics.liveAccepted).toBe(0);
  expect(p.a.assisted).toBe(false);
  expect(p.b.assisted).toBe(true);
  expect(
    p.a.residents.every(
      (r) => r.source === "jev" && r.provenance === "recorded",
    ),
  ).toBe(true);
});
test("request receipt remains byte-identical while the observed world advances and replies are stored", () => {
  const w = createWorld();
  setController(w, "jev", true);
  const ticket = issueTicket(w),
    input = observation(w, ticket),
    q = questions(ticket),
    wire = JSON.stringify({ state: input, questions: q });
  for (let i = 0; i < 30; i++) advance(w);
  applyReply(w, ticket, reply(ticket));
  w.decisions.at(-1)!.transport = { input, questions: q };
  for (let i = 0; i < 30; i++) advance(w);
  expect(JSON.stringify({ state: input, questions: q })).toBe(wire);
  expect(
    JSON.stringify({
      state: (w.decisions.at(-1)!.transport as any).input,
      questions: (w.decisions.at(-1)!.transport as any).questions,
    }),
  ).toBe(wire);
  // Check aliases even for arrays not normally edited by the physics loop.
  w.residents[0].memory.push("garden");
  w.residents[0].traits.push("mutated-test-trait");
  expect(JSON.stringify({ state: input, questions: q })).toBe(wire);
  expect(input.residents[0].needs).not.toBe(w.residents[0].needs);
  expect(input.residents[0].preferences).not.toBe(w.residents[0].traits);
  expect(input.residents[0].lastVisits).not.toBe(w.residents[0].memory);
});
import { FixedClock } from "./engine";
test("fixed clock retains a long-frame backlog and caps work without changing the future", () => {
  const smooth = createWorld(19),
    stalled = copy(smooth),
    clock = new FixedClock();
  step(smooth, 8);
  let n = clock.take(8, 1, 7),
    total = n;
  expect(n).toBe(7);
  expect(clock.backlog).toBeGreaterThan(7);
  for (let i = 0; i < n; i++) advance(stalled);
  while ((n = clock.take(0, 1, 7)) > 0) {
    expect(n).toBeLessThanOrEqual(7);
    total += n;
    for (let i = 0; i < n; i++) advance(stalled);
  }
  expect(total).toBe(240);
  expect(stalled).toEqual(smooth);
  expect(clock.backlog).toBeLessThan(1e-8);
});
test("clock reset drops only deliberate pause/restore backlog and fractional normal frames accumulate", () => {
  const clock = new FixedClock();
  let total = 0;
  for (let i = 0; i < 60; i++) total += clock.take(1 / 60);
  expect(total).toBe(30);
  clock.take(10, 1, 3);
  expect(clock.backlog).toBeGreaterThan(9);
  clock.reset();
  expect(clock.take(0)).toBe(0);
  expect(clock.take(0.5, 2)).toBe(30);
});
import { beginRequest, finishRequest } from "./engine";
test("durable receipts retain failed and cancelled requests without leaking future answers into checkpoints", () => {
  const p = createPair();
  setController(p.a, "jev");
  const t = issueTicket(p.a),
    input = observation(p.a, t),
    q = questions(t),
    id = beginRequest(p.a, t, input, q),
    wire = JSON.stringify(input),
    saved = checkpoint(p);
  step(p.a, 1);
  expect(
    finishRequest(p.a, id, "returned", { response: { answers: reply(t) } }),
  ).toBe(true);
  expect(saved.pair.a.requests[0].status).toBe("pending");
  expect(saved.pair.a.requests[0].response).toBeUndefined();
  const restored = forkPair(saved, "receipt-fork", "Restored pending request");
  expect(restored.a.requests[0].status).toBe("cancelled");
  expect(restored.a.requests[0].response).toBeUndefined();
  expect(saved.pair.a.requests[0].status).toBe("pending");
  expect(JSON.stringify(p.a.requests[0].input)).toBe(wire);
  const cancelled = beginRequest(p.a, t, input, q);
  expect(
    finishRequest(p.a, cancelled, "cancelled", { error: "New branch" }),
  ).toBe(true);
  expect(finishRequest(p.a, cancelled, "returned", { response: {} })).toBe(
    false,
  );
  const failed = beginRequest(p.a, t, input, q);
  finishRequest(p.a, failed, "failed", { error: "Unavailable" });
  expect(p.a.requests.map((r) => r.status)).toEqual([
    "returned",
    "cancelled",
    "failed",
  ]);
  input.residents[0].needs.hunger = 1;
  expect(JSON.stringify(p.a.requests[0].input)).toBe(wire);
});
