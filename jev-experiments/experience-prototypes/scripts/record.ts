import { readRecord, writeRecord } from "./records";
import "./credentials";
import { existsSync } from "node:fs";
import { evaluate } from "./local-model";
import { compose } from "./local-model";
import { pasteSources, recordedRequests } from "../src/new-experiments";
const dir = "results";
const save = (name: string, result: unknown) =>
  writeRecord(`${dir}/${name}.jsonl`, {
    manifest: {
      experiment: name,
      created: new Date().toISOString(),
      status: "complete",
    },
    result,
  });
const job = async (name: string, fn: () => Promise<void>) => {
  if (existsSync(`${dir}/${name}.jsonl`)) {
    console.log(name + ": checkpoint exists");
    return;
  }
  try {
    await fn();
    console.log(name + ": complete");
  } catch (e) {
    console.log(name + ": " + String(e));
  }
};
await job("paste", async () => {
  const rows = [];
  for (const [preset, source] of Object.entries(pasteSources)) {
    const r = await evaluate(recordedRequests.paste(preset as keyof typeof pasteSources, source));
    rows.push({ preset, source_text: source, ...r });
  }
  save("paste", { rows });
});
await job("semantic-table", async () => save("semantic-table", await evaluate(recordedRequests.semanticTable())));
await job("undo", async () => save("undo", await evaluate(recordedRequests.undo())));
await job("changes", async () => save("changes", await evaluate(recordedRequests.changes())));
{
  const path = "results/composed-ui.jsonl";
  const previous = existsSync(path) ? readRecord(path).result : { rows: [] };
  const rows = [];
  for (const [domain, prompt] of [
    [
      "settings",
      "Create account settings with name, email, notifications, and a save button.",
    ],
    [
      "apartments",
      "Compare all three apartments. Show each rent, commute, budget, and a shortlist button for each apartment.",
    ],
    [
      "event",
      "Create an event planning form with event name, location, guests, dietary preference, and save.",
    ],
  ]) {
    const done = previous.rows.find(
      (r: any) => r.domain === domain && r.stopReason === "finish",
    );
    if (done) {
      rows.push(done);
      continue;
    }
    let last: any;
    const steps = [];
    for await (const e of compose(
      { domain, prompt },
      AbortSignal.timeout(120000),
    )) {
      last = e;
      if (e.type === "step") steps.push(e.step);
    }
    rows.push({ domain, prompt, catalog_version: 2, ...last, steps });
    console.log(domain + ": " + last?.stopReason);
    save("composed-ui", {
      rows,
      previous_attempts: [
        ...(previous.previous_attempts ?? []),
        ...previous.rows.filter((r: any) => r.stopReason !== "finish"),
      ],
    });
  }
  save("composed-ui", {
    rows,
    previous_attempts: [
      ...(previous.previous_attempts ?? []),
      ...previous.rows.filter((r: any) => r.stopReason !== "finish"),
    ],
  });
}
