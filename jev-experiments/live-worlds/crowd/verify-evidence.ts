// Offline verification only. No credentials, provider calls or model inference.
import { readRecord } from "../../experience-prototypes/scripts/records";
import { observation, questions, type World } from "./engine";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
const record = readRecord(new URL("./demo.jsonl", import.meta.url)),
  r = record.result;
const derived = JSON.parse(
  readFileSync(new URL("./demo.json", import.meta.url), "utf8"),
);
const hash = createHash("sha256")
  .update(JSON.stringify(r.request))
  .digest("hex");
const native = JSON.parse(r.attempts[0].responseBody);
const normalized = Object.entries(r.response.answers).every(
  ([id, a]: any) =>
    native.answers[id].type === a.type &&
    native.answers[id][a.type] === a.value &&
    isDeepStrictEqual(
      native.answers[id].probabilities ?? null,
      a.probabilities,
    ),
);
const suspiciousFields: string[] = [];
function inspect(v: any, path: string[] = []) {
  if (!v || typeof v !== "object") return;
  for (const [k, value] of Object.entries(v)) {
    if (/^(authorization|api[-_]?key|cookie|headers)$/i.test(k))
      suspiciousFields.push([...path, k].join("."));
    inspect(value, [...path, k]);
  }
}
inspect(record);
const out = {
  canonicalEqualsDerived: isDeepStrictEqual(record, derived),
  requestHashMatches: hash === record.manifest.request_sha256,
  snapshotObservationMatches: isDeepStrictEqual(
    observation(r.snapshot as World, r.ticket),
    r.request.state,
  ),
  questionsMatch: isDeepStrictEqual(questions(r.ticket), r.request.questions),
  wireBodyMatches: isDeepStrictEqual(
    {
      state: r.attempts[0].requestBody.state,
      questions: r.attempts[0].requestBody.questions,
    },
    r.request,
  ),
  allNativeAnswersRetained: normalized,
  answerCount: Object.keys(r.response.answers).length,
  attemptCount: r.attempts.length,
  statuses: r.attempts.map((a: any) => a.status),
  suspiciousCredentialFields: suspiciousFields,
  providerCalls: 0,
};
if (
  Object.entries(out).some(([k, v]) => typeof v === "boolean" && !v) ||
  suspiciousFields.length
)
  throw Error("Recorded evidence verification failed");
writeFileSync(
  new URL("./qa/evidence-checks.json", import.meta.url),
  JSON.stringify(out, null, 2) + "\n",
);
console.log(JSON.stringify(out, null, 2));
