/** Resume only transport failures. Never retry a completed judgment to improve its score. */
import "./credentials";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { evaluate, GatewayError } from "../server/gateway";
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const names = ["classify", "judge", "robustness", "routing", "visuals"];
for (const name of names) {
  const path = `results/${name}.json`,
    original = read(`../results/${name}.json`);
  const doc = existsSync(path) ? read(path) : read(`public/data/${name}.json`),
    result = doc.result;
  const log = readFileSync(
    `../runs/${original.manifest.id}/requests.jsonl`,
    "utf8",
  )
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  const requests = new Map(log.filter((r) => r.request).map((r) => [r.tag, r]));
  const groups =
    name === "classify" ? Object.entries(result.experiments) : [[name, result]];
  const tasks: any[] = [];
  for (const [group, value] of groups as [string, any][]) {
    for (const row of value.rows ?? value.scenes ?? []) {
      if (
        !row.error ||
        !/(HTTP (408|429|500|502|503|504)|timeout|timed out|network)/i.test(
          row.error,
        )
      )
        continue;
      const tag =
        name === "classify"
          ? `${group}/${row.id}`
          : name === "judge"
            ? `judge/${row.id}`
            : name === "routing"
              ? `router/${row.id}`
              : name === "visuals"
                ? `scene/${row.id}`
                : row.id;
      const req = requests.get(tag);
      if (!req) {
        console.log(`${name}/${row.id}: original request missing`);
        continue;
      }
      if (name === "classify")
        row.target = value.baseline_rows.find(
          (r: any) => r.id === row.id,
        )?.target;
      tasks.push({ row, req, group });
    }
  }
  const save = () => writeFileSync(path, JSON.stringify(doc, null, 2));
  result.recovery ??= {
    started: new Date().toISOString(),
    original_run: original.manifest.id,
    policy:
      "Only transport failures retried. All completed predictions retained, including incorrect predictions.",
    attempts: [],
  };
  console.log(`${name}: ${tasks.length} transport failures to resume`);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const { row, req, group } = tasks[cursor++];
      const priorError = row.error;
      try {
        const response = await evaluate({
          state: req.request.state,
          questions: req.request.questions,
        });
        const id =
          name === "judge" ? "winner" : name === "routing" ? "route" : "intent";
        const answer = response.answers[id];
        row.original_error = priorError;
        delete row.error;
        if (name === "visuals") {
          Object.assign(row, {
            brief: req.request.state,
            scene: Object.fromEntries(
              Object.entries(response.answers).map(([k, a]) => [k, a.value]),
            ),
          });
        } else if (answer) {
          Object.assign(row, {
            prediction: answer.value,
            probabilities: answer.probabilities,
            confidence: answer.confidence,
          });
        } else throw new Error(`Missing answer ${id}`);
        if (name === "judge")
          row.atomic_prediction =
            response.answers.a_correct.value >= response.answers.b_correct.value
              ? "A"
              : "B";
        if (name === "routing") row.text = req.request.state;
        if (name === "robustness") {
          row.case = row.id.slice(0, row.id.lastIndexOf("/"));
          row.variant = row.id.split("/").at(-1);
          row.target ??= result.rows.find(
            (r: any) => r.case === row.case && r.target,
          )?.target;
        }
        Object.assign(row, {
          answers: response.answers,
          latency_ms: response.latency_ms,
          recovery: {
            at: new Date().toISOString(),
            attempts: response.attempts,
            cost_usd: response.cost_usd,
            original_request_hash: req.request_hash,
          },
        });
        result.recovery.attempts.push({
          id: row.id,
          group,
          status: "completed",
          ...row.recovery,
        });
      } catch (e) {
        row.error = priorError;
        result.recovery.attempts.push({
          id: row.id,
          group,
          status: "unavailable",
          message: String(e),
          attempts: e instanceof GatewayError ? e.attempts : [],
        });
        save();
        if (e instanceof GatewayError && e.retryAfterMs) {
          console.log(
            `Provider asked for a ${Math.ceil(e.retryAfterMs / 1000)}s cooldown. Checkpoint saved.`,
          );
          await Bun.sleep(e.retryAfterMs);
        }
      }
      save();
      console.log(
        `${name}/${row.id}: ${row.error ? "still unavailable" : "recovered"}`,
      );
    }
  }
  await worker();
  save();
}
