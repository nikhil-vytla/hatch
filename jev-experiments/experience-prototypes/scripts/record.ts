import "./credentials";
import {
  writeFileSync,
  existsSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { evaluate } from "../server/gateway";
import { compose } from "../server/compose";
import {
  pasteSources,
  pasteFields,
  extractFacts,
  pasteQuestions,
  supportRows,
  edits,
  impactFacts,
  conclusions,
} from "../src/new-experiments";
import { judge } from "../src/api";
const dir = "results";
const save = (name: string, result: unknown) =>
  writeFileSync(
    `${dir}/${name}.json`,
    JSON.stringify(
      {
        manifest: {
          experiment: name,
          created: new Date().toISOString(),
          status: "complete",
        },
        result,
      },
      null,
      2,
    ),
  );
const job = async (name: string, fn: () => Promise<void>) => {
  if (existsSync(`${dir}/${name}.json`)) {
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
    const fields = pasteFields[preset as keyof typeof pasteFields];
    const r = await evaluate({
      state: { source, destination: preset },
      questions: pasteQuestions(fields, extractFacts(source), preset),
    });
    rows.push({ preset, source_text: source, ...r });
  }
  save("paste", { rows });
});
await job("semantic-table", async () =>
  save(
    "semantic-table",
    await evaluate({
      state: {
        conversations: Object.fromEntries(
          supportRows.map((r) => [r.id, r.text]),
        ),
      },
      questions: Object.fromEntries(
        supportRows.map((r) => [
          r.id,
          judge(
            `For conversation ${r.id}: Was a refund promised but no successful refund is evidenced?`,
          ),
        ]),
      ),
    }),
  ),
);
await job("undo", async () =>
  save(
    "undo",
    await evaluate({
      state: {
        request: "Undo the color changes, but keep the new layout and title.",
        edits,
      },
      questions: Object.fromEntries(
        edits.map((e) => [
          e.id,
          judge(
            `Should edit ${e.id} be undone to satisfy the request? Preserve unrelated edits.`,
          ),
        ]),
      ),
    }),
  ),
);
await job("changes", async () =>
  save(
    "changes",
    await evaluate({
      state: {
        before: impactFacts,
        after: { ...impactFacts, venue: "Waterfront Pavilion, Portland" },
        conclusions,
      },
      questions: Object.fromEntries(
        conclusions.map((c) => [
          c.id,
          judge(
            `Does conclusion ${c.id} need review because the facts changed?`,
          ),
        ]),
      ),
    }),
  ),
);
{
  const path = "results/composed-ui.json";
  const previous = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")).result
    : { rows: [] };
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
