import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readRecord } from "../experience-prototypes/scripts/records";
import {
  evaluate,
  GatewayError,
} from "../experience-prototypes/scripts/local-model";
import {
  INITIAL_OUTFIT,
  editState,
  editQuestions,
  interpretEdit,
  fullPrompt,
  WARDROBE_VERSION,
} from "./engine";
const root = new URL("./", import.meta.url),
  transcripts = JSON.parse(
    readFileSync(new URL("speech-transcripts.json", root), "utf8"),
  ),
  path = new URL("spoken-pipeline.json", root);
const data = existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8"))
  : {
      created: new Date().toISOString(),
      version: WARDROBE_VERSION,
      source: transcripts.source,
      recognizer: transcripts.recognizer,
      sttModel: transcripts.model,
      sttInference: transcripts.inference,
      model: "typesafe-ai/jev",
      schedule:
        "Actual STT and Jev stages recorded first; accepted states replayed into a 30-second real Fal session. Replay timing is not end-to-end latency.",
      turns: [],
      providerFailures: [],
    };
const fixture = readRecord(new URL("wardrobe.jsonl", root));
const save = () => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
let current = data.turns.at(-1)?.after ?? INITIAL_OUTFIT;
for (const transcript of transcripts.turns) {
  if (data.turns.some((r: any) => r.id === transcript.id)) continue;
  let succeeded = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const matching = fixture.result.rows.find(
        (r: any) =>
          r.text === transcript.text &&
          JSON.stringify(r.before) === JSON.stringify(current),
      );
      const response = matching
        ? matching.response
        : await evaluate(
            {
              state: editState(current, transcript.text),
              questions: editQuestions(current),
            },
            { deadlineMs: 48000 },
          );
      const rawDecision = interpretEdit(current, response),
        decision = interpretEdit(current, response, transcript.text);
      data.turns.push({
        ...transcript,
        jevSource: matching
          ? "Previously recorded Jev response for identical transcript and canonical input"
          : "Fresh Jev call after transcription",
        reusedJevCaseId: matching?.id ?? null,
        originalJevRecordCreated: matching ? fixture.manifest.created : null,
        before: current,
        rawResponse: response,
        rawDecision,
        decision,
        after: decision.outfit,
        prompt: fullPrompt(decision.outfit),
      });
      current = decision.outfit;
      save();
      console.log(
        `${transcript.id}: ${decision.action}; ${decision.reason || "accepted"}; Jev ${response.wall_ms ?? response.latency_ms ?? "?"}ms`,
      );
      succeeded = true;
      break;
    } catch (e) {
      data.providerFailures.push({
        id: transcript.id,
        attempt: attempt + 1,
        error: e instanceof Error ? e.message : "Failed",
        attempts: e instanceof GatewayError ? e.attempts : [],
      });
      save();
      if (attempt < 2)
        await Bun.sleep(
          Math.max(5000, e instanceof GatewayError ? e.retryAfterMs : 0),
        );
    }
  }
  if (!succeeded)
    throw new Error(
      "Speech pipeline stopped: no provider response. See checkpoint; no expected state substituted.",
    );
  await Bun.sleep(2200);
}
data.status = "complete";
save();
