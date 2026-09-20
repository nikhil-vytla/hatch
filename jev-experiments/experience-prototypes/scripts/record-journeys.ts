import { readRecord, writeRecord } from "./records";
import "./credentials";
import { evaluate } from "./local-model";
import { drinkMenu, journeyStates, journeyQuestions } from "../src/journeys";
import { existsSync } from "node:fs";
const path = "results/journeys.jsonl";
if (!existsSync(path)) {
  const states = journeyStates(),
    result = await evaluate({
      state: { menu: drinkMenu, states },
      questions: journeyQuestions(states),
    });
  writeRecord(path, {
    manifest: {
      experiment: "journeys",
      created: new Date().toISOString(),
      status: "complete",
    },
    result: { ...result, states },
  });
  console.log("81 adaptive journey decisions recorded.");
}
