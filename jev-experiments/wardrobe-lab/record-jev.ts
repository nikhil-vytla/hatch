import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  evaluate,
  GatewayError,
} from "../experience-prototypes/scripts/local-model";
import {
  readRecord,
  writeRecord,
} from "../experience-prototypes/scripts/records";
import {
  DEMO_COMMANDS,
  INITIAL_OUTFIT,
  WARDROBE_VERSION,
  applyPatch,
  demoOutfits,
  editQuestions,
  editState,
  interpretEdit,
  type Outfit,
  type Patch,
} from "./engine";
const demo = demoOutfits(),
  dressed = demo.at(-1)!.after;
export const CASES = [
  ...demo.map((c) => ({ ...c, category: "cumulative-demo", action: "apply" })),
  {
    id: "negation",
    category: "negation",
    text: "Remove the sunglasses, not the jacket.",
    before: dressed,
    expected: { glasses: "none" } as Patch,
    action: "apply",
  },
  {
    id: "ambiguous",
    category: "ambiguity",
    text: "Make it bigger.",
    before: INITIAL_OUTFIT,
    expected: {},
    action: "clarify",
  },
  {
    id: "unsupported",
    category: "no-match",
    text: "Put red leather boots on me.",
    before: dressed,
    expected: {},
    action: "unsupported",
  },
  {
    id: "undo",
    category: "history",
    text: "Undo that last change.",
    before: dressed,
    expected: {},
    action: "undo",
  },
  {
    id: "reset",
    category: "history",
    text: "Reset the whole outfit.",
    before: dressed,
    expected: {},
    action: "reset",
  },
  {
    id: "metadata",
    category: "catalog-metadata",
    text: "Swap my jacket for the formal one with lapels. Keep everything else.",
    before: dressed,
    expected: { jacket: "blazer" } as Patch,
    action: "apply",
  },
  {
    id: "explicit-jacket",
    category: "pronoun-override",
    text: "Make the jacket pink and oversized. Keep my glasses as they are.",
    before: dressed,
    expected: { jacketColor: "pink", fit: "oversized" } as Patch,
    action: "apply",
  },
  {
    id: "negated-color",
    category: "negation",
    text: "Make the sunglasses amber, not black.",
    before: dressed,
    expected: { glassesColor: "amber" } as Patch,
    action: "apply",
  },
];
if (import.meta.main) {
  const path = fileURLToPath(new URL("./wardrobe.jsonl", import.meta.url)),
    previous = existsSync(path) ? readRecord(path) : null,
    rows: any[] = previous?.result?.rows ?? [],
    providerFailures: any[] = previous?.result?.providerFailures ?? [];
  const save = () =>
    writeRecord(path, {
      manifest: {
        experiment: "wardrobe-lab",
        version: WARDROBE_VERSION,
        model: "typesafe-ai/jev",
        created: previous?.manifest?.created ?? new Date().toISOString(),
        authored: true,
        status: rows.length === CASES.length ? "complete" : "partial",
      },
      result: {
        version: WARDROBE_VERSION,
        rows,
        providerFailures,
        coverage: {
          planned: CASES.length,
          completed: rows.length,
          declared: CASES.map((c) => c.id),
          missing: CASES.filter((c) => !rows.some((r) => r.id === c.id)).map(
            (c) => c.id,
          ),
          limitation:
            "12 authored development cases; one wording, one run; expected states were declared before calls. Not a held-out benchmark.",
        },
        metrics: {
          exact: rows.filter((r) => r.score.exact).length,
          total: rows.length,
          guardRejected: rows.filter((r) => r.decision.action === "rejected")
            .length,
        },
      },
    });
  save();
  for (const c of CASES) {
    if (rows.some((r) => r.id === c.id)) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await evaluate(
          {
            state: editState(c.before, c.text),
            questions: editQuestions(c.before),
          },
          { deadlineMs: 48000 },
        );
        const decision = interpretEdit(c.before, response, c.text);
        const expectedAfter =
          c.action === "apply" ? applyPatch(c.before, c.expected) : c.before;
        const exact =
          decision.action === c.action &&
          (c.action !== "apply" ||
            JSON.stringify(decision.outfit) === JSON.stringify(expectedAfter));
        rows.push({
          id: c.id,
          category: c.category,
          text: c.text,
          before: c.before,
          expected: {
            action: c.action,
            patch: c.expected,
            outfit: expectedAfter,
          },
          response,
          decision,
          score: { exact },
          provenance: "recorded-jev",
          commandSource: "authored-demo",
        });
        save();
        console.log(
          `${rows.length}/${CASES.length} ${c.id}: ${decision.action}, exact=${exact}`,
        );
        break;
      } catch (e) {
        providerFailures.push({
          id: c.id,
          attempt: attempt + 1,
          at: new Date().toISOString(),
          status: e instanceof GatewayError ? e.status : 0,
          error: e instanceof Error ? e.message : "Provider failure",
          attempts: e instanceof GatewayError ? e.attempts : [],
        });
        save();
        console.log(`${c.id}: provider failure (${attempt + 1}/3)`);
        if (attempt < 2)
          await Bun.sleep(
            Math.max(5000, e instanceof GatewayError ? e.retryAfterMs : 0),
          );
      }
    }
    await Bun.sleep(2200);
  }
}
