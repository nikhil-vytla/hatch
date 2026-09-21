// One authorized demo batch. This file is local-only and never imported by the app.
import { evaluate } from "../../experience-prototypes/scripts/local-model";
import { writeRecord } from "../../experience-prototypes/scripts/records";
import {
  createWorld,
  setController,
  setNotice,
  issueTicket,
  observation,
  questions,
  copy,
  applyReply,
} from "./engine";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import type { Payload } from "../../experience-prototypes/server/gateway";
const target = new URL("./demo.jsonl", import.meta.url);
if (existsSync(target))
  throw Error("A saved demo exists. Do not overwrite evidence.");
const w = createWorld(27, "recorded-afternoon");
setController(w, "jev", true);
setNotice(
  w,
  "A quiet tea-and-book afternoon in the reading room. Come if you need a break from conversation.",
);
const ticket = issueTicket(w),
  snapshot = copy(w),
  request = {
    state: observation(w, ticket),
    questions: questions(ticket),
  } as Payload;
const attempts: any[] = [];
const started = new Date().toISOString();
try {
  const response = await evaluate(request, {
    deadlineMs: 45000,
    fetcher: async (input, init) => {
      const before = performance.now();
      const r = await fetch(input, init);
      attempts.push({
        at: new Date().toISOString(),
        status: r.status,
        latency_ms: performance.now() - before,
        retryAfter: r.headers.get("retry-after"),
        requestBody: JSON.parse(String(init?.body)),
        responseBody: await r.clone().text(),
      });
      return r;
    },
  });
  const outcome = applyReply(w, ticket, response.answers);
  const record = {
    manifest: {
      experiment: "living-crowd",
      status: "complete",
      created: started,
      finished: new Date().toISOString(),
      coverage:
        "One authored notice, twelve fictional residents, one actual batch. Not a benchmark.",
      request_sha256: createHash("sha256")
        .update(JSON.stringify(request))
        .digest("hex"),
    },
    result: {
      snapshot,
      ticket,
      request,
      response,
      attempts,
      outcome,
      playback:
        "Exact recorded decisions applied at the frozen checkpoint. Replay does not reproduce service latency.",
    },
  };
  writeRecord(target.pathname, record);
  writeFileSync(
    new URL("./demo.json", import.meta.url),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        status: "complete",
        questions: Object.keys(request.questions).length,
        attempts: attempts.map((a) => ({
          status: a.status,
          latency_ms: a.latency_ms,
        })),
        outcome,
        targets: Object.entries(response.answers)
          .filter(([k]) => k.startsWith("destination"))
          .map(([id, a]: any) => ({ id, value: a.value })),
      },
      null,
      2,
    ),
  );
} catch (e) {
  writeRecord(new URL("./demo-failure.jsonl", import.meta.url).pathname, {
    manifest: { created: started, status: "provider-failed" },
    result: { snapshot, ticket, request, attempts, error: String(e) },
  });
  throw e;
}
