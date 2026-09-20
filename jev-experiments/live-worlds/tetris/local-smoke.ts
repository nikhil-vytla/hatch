import { TetrisSession, type Ticket } from "./session";

// A deterministic local mechanics check, not evidence of Jev ability or latency.
const session = new TetrisSession(19), queue: Ticket[] = [];
session.play();
for (let t = 0; t < 60_000; t += 20) {
  session.advance(20);
  queue.push(...session.requests(false));
  for (let i = queue.length - 1; i >= 0; i--) {
    const ticket = queue[i];
    if (session.pair.clockMs - ticket.sentAt >= ticket.settings.delayMs) {
      session.receive(ticket, ticket.suggested, ticket.settings.delayMs); queue.splice(i, 1);
    }
  }
}
const output = {
  protocol: "Pure-engine local planner, seed 19, 60 seconds simulated time, 20ms steps, artificial 450ms response delay, 900ms request interval, 700ms fallback wait from each new piece in the assisted lane. No model calls. This bounded smoke check does not cap actual play.",
  worldMs: session.pair.clockMs,
  lanes: session.pair.lanes.map(l => ({ settings: l.settings, pieces: l.game.pieces, lines: l.game.lines, level: l.game.level, score: l.game.score, status: l.game.status, stats: l.stats })),
};
if (output.lanes.some(l => l.stats.jevMs !== 0 || l.pieces <= 32 || l.status !== "playing" || l.lines === 0)) throw new Error("Local mechanics smoke check did not finish as expected");
await Bun.write(new URL("./local-smoke.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
