import { describe, expect, test } from "bun:test";
import { command } from "./engine";
import { DECISION_INSTRUCTIONS, snapshot, TetrisSession } from "./session";

function unassisted() { const s = new TetrisSession(); s.configure(0, { assisted: false }); s.configure(1, { assisted: false }); s.play(); return s; }
describe("paired live lifecycle", () => {
  test("world keeps falling during pending work, with identical clocks", () => {
    const s = unassisted(), tickets = s.requests(false); expect(tickets).toHaveLength(2);
    s.advance(1000);
    expect(s.pair.clockMs).toBe(1000);
    expect(s.pair.lanes.map(l => l.game.timeMs)).toEqual([1000, 1000]);
    expect(s.pair.lanes.map(l => l.game.active.y)).toEqual([0, 0]);
    expect(s.requests(false)).toEqual([]);
    expect(s.receive(tickets[0], tickets[0].suggested, 1000)).toBe("accepted");
  });
  test("long rendering stalls retain excess elapsed simulation time", () => {
    const s = unassisted(); s.advance(6200);
    expect(s.pair.clockMs).toBe(5000); s.advance(0); expect(s.pair.clockMs).toBe(6200);
  });
  test("short decisions expire and answers about a previous piece are stale", () => {
    const s = unassisted(); s.configure(0, { framing: "button" }); const tickets = s.requests(false);
    s.advance(400); expect(s.receive(tickets[0], tickets[0].suggested, 400)).toBe("stale");
    command(s.pair.lanes[1].game, "drop");
    expect(s.receive(tickets[1], tickets[1].suggested, 400)).toBe("stale");
    expect(s.pair.lanes[1].plan).toBeNull();
  });
  test("changing one controller invalidates only its own pending request", () => {
    const s = unassisted(), tickets = s.requests(false);
    s.configure(0, { framing: "intent" });
    expect(s.receive(tickets[0], tickets[0].suggested, 50)).toBe("cancelled");
    expect(s.receive(tickets[1], tickets[1].suggested, 50)).toBe("accepted");
  });
  test("same-state human takeover cancels late answers and hands back without reset", () => {
    const s = unassisted(), tickets = s.requests(false); s.advance(180);
    const before = structuredClone(s.pair.lanes[0].game); s.takeover(0);
    expect(s.pair.lanes[0].game).toEqual(before);
    s.input(0, "left"); expect(s.pair.lanes[0].game.active.x).toBe(before.active.x - 1);
    expect(s.receive(tickets[0], tickets[0].suggested, 250)).toBe("cancelled");
    const moved = structuredClone(s.pair.lanes[0].game); s.takeover(0); expect(s.pair.lanes[0].game).toEqual(moved);
  });
  test("scrubbing sends no requests; branching preserves history and cancels old work", () => {
    const s = unassisted(); s.advance(1000); const tickets = s.requests(false);
    s.scrub(2); const selected = snapshot(s.shown); expect(s.requests(false)).toEqual([]);
    s.branch(); expect(s.saved).toHaveLength(1); expect(s.saved[0].tail.clockMs).toBe(1000);
    expect(s.pair.clockMs).toBe(selected.clockMs); expect(s.pair.lanes[0].game).toEqual(selected.lanes[0].game);
    expect(s.history[0]).toEqual(s.pair); expect(s.receive(tickets[0], tickets[0].suggested, 500)).toBe("cancelled");
    s.play(); s.advance(200); expect(s.history).toHaveLength(2); expect(s.requests(false)).toHaveLength(2);
  });
  test("restoring an older run resumes recording and requests immediately", () => {
    const s = unassisted(); s.advance(1000); const run = s.preserve("old");
    s.play(); s.advance(4000); s.requests(false); s.restore(run.id);
    expect(s.pair.clockMs).toBe(1000); const count = s.history.length;
    s.play(); s.advance(200); expect(s.history.length).toBe(count + 1); expect(s.requests(false)).toHaveLength(2);
    expect(s.pair.lanes.map(l => l.game.timeMs)).toEqual([1200, 1200]);
  });
  test("fallback is separately attributed and both lanes can use the same Jev framing", () => {
    const s = new TetrisSession(); s.configure(0, { source: "jev", fallbackWaitMs: 0 }); s.configure(1, { source: "jev" }); s.play();
    expect(s.requests(false)).toEqual([]); const requests = s.requests(true);
    expect(requests.map(r => r.framing)).toEqual(["landing", "landing"]);
    s.advance(100); expect(s.pair.lanes[0].stats.fallbackMs).toBe(100); expect(s.pair.lanes[1].stats.gravityMs).toBe(100);
    expect(s.pair.lanes[0].stats.jevMs).toBe(0);
    s.receive(requests[1], requests[1].suggested, 100); s.advance(20); expect(s.pair.lanes[1].stats.jevMs).toBe(20);
  });
  test("provider failures do not stop gravity and restart preserves old run", () => {
    const s = unassisted(); const t = s.requests(false)[1]; expect(s.receive(t, undefined, 30, "offline")).toBe("failed");
    s.advance(1000); expect(s.running).toBe(true); expect(s.pair.lanes[1].game.active.y).toBe(0);
    s.restart(42); expect(s.saved[0].tail.clockMs).toBe(1000); expect(s.pair.clockMs).toBe(0);
    expect(s.pair.lanes[0].game).toEqual(s.pair.lanes[1].game); expect(s.pair.lanes[0].game.status).toBe("playing");
  });
  test("historical inspector never exposes an answer before its arrival", () => {
    const s = unassisted(), ticket = s.requests(false)[1]; s.advance(400); s.receive(ticket, ticket.suggested, 400);
    const past = s.eventsThrough(200).find(e => e.id === ticket.id)!;
    expect(past.status).toBe("pending"); expect(past.answer).toBeUndefined(); expect(past.latencyMs).toBeUndefined();
    expect(s.eventsThrough(400).find(e => e.id === ticket.id)!.status).toBe("accepted");
  });
  test("invalid upstream choices cannot create accepted control plans", () => {
    const s = unassisted(), ticket = s.requests(false)[1];
    expect(s.receive(ticket, "__proto__", 10)).toBe("failed"); expect(s.pair.lanes[1].plan).toBeNull();
  });
  test("matched comparison forks either physical board while retaining lane settings", () => {
    const s = new TetrisSession(42); s.configure(0, { fallbackWaitMs: 0 }); s.play(); s.advance(800);
    expect(s.pair.lanes[0].game).not.toEqual(s.pair.lanes[1].game);
    const chosen = structuredClone(s.pair.lanes[0].game); s.compareFrom(0);
    expect(s.pair.seed).toBe(42); expect(s.saved).toHaveLength(1);
    expect(s.pair.lanes.map(l => l.game)).toEqual([chosen, chosen]);
    expect(s.pair.lanes.map(l => l.settings.assisted)).toEqual([true, false]);
    expect(s.pair.lanes.map(l => l.plan)).toEqual([null, null]);
    expect(s.pair.lanes.map(l => l.stats.fallbackMs)).toEqual([0, 0]);
    expect(s.history[0]).toEqual(s.pair);
  });
  test("same-tick request, acceptance, failure and cancellation update the checkpoint", () => {
    const s = unassisted(), tickets = s.requests(false);
    expect(s.history[0].lanes[1].pending).toBe(tickets[1].id);
    s.advance(200);
    expect(s.history.at(-1)!.lanes[1].stats.accepted).toBe(0);
    s.receive(tickets[1], tickets[1].suggested, 200);
    const accepted = s.history.find(h => h.clockMs === 200)!.lanes[1];
    expect(accepted.pending).toBeNull(); expect(accepted.stats.accepted).toBe(1); expect(accepted.plan).not.toBeNull();
    expect(s.eventsThrough(200).find(e => e.id === tickets[1].id)!.status).toBe("accepted");
    s.receive(tickets[0], undefined, 200, "unavailable");
    expect(s.history.find(h => h.clockMs === 200)!.lanes[0].stats.failed).toBe(1);
    const c = unassisted(), cancelled = c.requests(false)[0]; c.advance(200); c.pause();
    expect(c.history.find(h => h.clockMs === 200)!.lanes[0].pending).toBeNull();
    expect(c.history.find(h => h.clockMs === 200)!.lanes[0].stats.cancelled).toBe(1);
    expect(c.eventsThrough(200).find(e => e.id === cancelled.id)!.status).toBe("cancelled");
  });
  test("receipt freezes the complete issued body and retains the normalized gateway reply", () => {
    const s = unassisted(); s.configure(1, { source: "jev" }); const ticket = s.requests(true)[1];
    const requestBefore = JSON.stringify(ticket.request);
    expect(ticket.request.questions.decision.instructions).toBe(DECISION_INSTRUCTIONS.landing);
    expect(ticket.request.questions.decision.criteria).toEqual(ticket.options);
    expect(Object.isFrozen(ticket.request.questions.decision.criteria)).toBe(true);
    const response = { answers: { decision: { type: "choice", value: ticket.suggested, probabilities: { [ticket.suggested]: 0.83 }, confidence: 0.83 } }, model: "typesafe-ai/jev", latency_ms: 198, service_latency_ms: 170, cost_usd: 0.0002, retries: 0, attempts: [{ attempt: 1, status: 200, latency_ms: 170 }], source: "live" };
    const original = structuredClone(response); s.advance(200); s.receive(ticket, ticket.suggested, 201, undefined, response, 200);
    response.answers.decision.probabilities[ticket.suggested] = 0.01; response.attempts[0].status = 500;
    const event = s.export().events.find(e => e.id === ticket.id)!;
    expect(JSON.stringify(event.request)).toBe(requestBefore); expect(event.response).toEqual(original); expect(event.httpStatus).toBe(200);
    expect(s.eventsThrough(100).find(e => e.id === ticket.id)!.response).toBeUndefined();
    const saved = s.preserve(); expect(saved.events.find(e => e.id === ticket.id)!.response).toEqual(original);
  });
  test("failed and cancelled receipts keep the exact request without inventing a reply", () => {
    const s = unassisted(), tickets = s.requests(false);
    const response = { error: "unavailable", attempts: [{ status: 503, latency_ms: 45 }], retry_after_ms: 1000 };
    s.advance(200); s.receive(tickets[0], undefined, 200, "unavailable", response, 503); s.pause();
    const failed = s.events.find(e => e.id === tickets[0].id)!, cancelled = s.events.find(e => e.id === tickets[1].id)!;
    expect(failed.status).toBe("failed"); expect(failed.request).toEqual(tickets[0].request); expect(failed.response).toEqual(response); expect(failed.httpStatus).toBe(503);
    expect(cancelled.status).toBe("cancelled"); expect(cancelled.request).toEqual(tickets[1].request); expect(cancelled.response).toBeUndefined(); expect(cancelled.receivedAt).toBeUndefined();
  });
  test("a returned local or Jev decision within grace can control the assisted lane", () => {
    for (const source of ["local", "jev"] as const) {
      const s = new TetrisSession(); s.configure(0, { source }); s.play();
      expect(s.pair.lanes[0].settings.fallbackWaitMs).toBe(700);
      const ticket = s.requests(true)[0]; s.advance(460);
      expect(s.pair.lanes[0].stats.fallbackMs).toBe(0); expect(s.pair.lanes[0].plan).toBeNull();
      expect(s.receive(ticket, ticket.suggested, 450)).toBe("accepted"); s.advance(20);
      expect(s.pair.lanes[0].stats[source === "jev" ? "jevMs" : "demoMs"]).toBe(20);
      expect(s.pair.lanes[0].stats.fallbackMs).toBe(0);
    }
  });
  test("missing replies allow gravity during grace and eventually choose fallback", () => {
    const s = new TetrisSession(); s.configure(0, { fallbackWaitMs: 1200 }); s.play(); s.advance(1000);
    expect(s.pair.lanes[0].game.active.y).toBe(0); expect(s.pair.lanes[0].stats.gravityMs).toBe(1000); expect(s.pair.lanes[0].plan).toBeNull();
    s.advance(200); expect(s.pair.lanes[0].plan?.origin).toBe("fallback"); expect(s.pair.lanes[0].stats.fallbackMs).toBe(20);
    const immediate = new TetrisSession(); immediate.configure(0, { fallbackWaitMs: 0 }); immediate.play(); immediate.advance(20);
    expect(immediate.pair.lanes[0].plan?.origin).toBe("fallback"); expect(immediate.pair.lanes[0].stats.fallbackMs).toBe(20);
  });
  test("each new piece gets grace even before its next request is due", () => {
    const s = new TetrisSession(); s.play(); const first = s.requests(false)[0]; s.advance(400);
    // The first advertised landing is the current pose's direct hard drop.
    s.receive(first, Object.keys(first.options)[0], 400); s.advance(20);
    const lane = s.pair.lanes[0]; expect(lane.game.pieceId).toBe(2); expect(lane.pieceStartedAt).toBe(420);
    expect(lane.pending).toBeNull(); expect(lane.nextRequestAt).toBe(900);
    s.advance(300); expect(s.pair.clockMs).toBe(720); expect(lane.plan).toBeNull(); expect(lane.stats.fallbackMs).toBe(0);
    expect(s.requests(false).some(t => t.lane === 0)).toBe(false);
    s.advance(380); expect(lane.plan).toBeNull(); s.advance(20); expect(lane.plan?.origin).toBe("fallback");
  });
  test("changing wait keeps valid decisions and snapshots retain piece-grace timing", () => {
    const s = new TetrisSession(); s.play(); const ticket = s.requests(false)[0]; s.advance(100);
    s.receive(ticket, ticket.suggested, 100); const plan = structuredClone(s.pair.lanes[0].plan);
    s.configure(0, { fallbackWaitMs: 1400 }); expect(s.pair.lanes[0].plan).toEqual(plan);
    const old = s.preserve(); const savedBirth = old.tail.lanes[0].pieceStartedAt;
    s.play(); s.advance(1000); s.restore(old.id);
    expect(s.pair.lanes[0].pieceStartedAt).toBe(savedBirth); expect(s.pair.lanes[0].settings.fallbackWaitMs).toBe(1400);
    expect(s.history.at(-1)).toEqual(s.pair);
    s.compareFrom(0); expect(s.pair.lanes.map(l => l.pieceStartedAt)).toEqual([savedBirth, savedBirth]);
  });
  test("explicit local slow-reply preset preserves prior Jev settings and physical board", () => {
    const s = new TetrisSession(); s.configure(0, { source: "jev" }); s.configure(1, { source: "jev" }); s.takeover(1);
    const before = snapshot(s.pair); s.slowReplyDemo();
    expect(s.saved[0].tail).toEqual(before);
    expect(s.pair.lanes.map(l => l.settings.source)).toEqual(["local", "local"]);
    expect(s.pair.lanes.map(l => l.settings.delayMs)).toEqual([1200, 1200]);
    expect(s.pair.lanes.map(l => l.settings.fallbackWaitMs)).toEqual([700, 700]);
    expect(s.pair.lanes.map(l => l.settings.assisted)).toEqual([true, false]);
    expect(s.pair.lanes.map(l => l.human)).toEqual([false, false]);
    expect(s.pair.lanes[0].game).toEqual(s.pair.lanes[1].game); expect(s.running).toBe(false);
  });
});
