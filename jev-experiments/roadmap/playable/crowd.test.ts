import { test, expect } from "bun:test";
import { createPair, checkpoint, issueTicket, applyReply, setController } from "../../live-worlds/crowd/engine";
import { compareNotices, routeDifferences } from "./crowd";
test("notice comparison copies one frozen world, preserving policy and physical conditions", () => {
  const from = checkpoint(createPair()), p = compareNotices(from, "paired", ["quiet books", "music tonight"], "notice", "b");
  expect(p.a.time).toBe(p.b.time); expect(p.a.rng).toBe(p.b.rng); expect(p.a.weather).toBe(p.b.weather); expect(p.a.controller).toBe(p.b.controller); expect(p.a.assisted).toBe(false);
  expect(p.a.residents.map(r => [r.x, r.y, r.needs])).toEqual(p.b.residents.map(r => [r.x, r.y, r.needs])); expect(routeDifferences(p).some(r => r.different)).toBe(true);
});
test("a pre-comparison request cannot apply to either new lane", () => { const pair = createPair(); setController(pair.a, "jev", false); const ticket = issueTicket(pair.a), p = compareNotices(checkpoint(pair), "new", ["tea", "tea again"], "jev"); const result = applyReply(p.a, ticket, {}); expect(result.accepted).toBe(0); expect(result.stale).toBe(Object.keys(ticket.actors).length); });
