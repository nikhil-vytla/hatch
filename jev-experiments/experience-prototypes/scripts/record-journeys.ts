import "./credentials";
import { evaluate } from "../server/gateway";
import { drinkMenu, journeyStates, journeyQuestions } from "../src/journeys";
import { writeFileSync, existsSync } from "node:fs";
const path = "results/journeys.json";
if (!existsSync(path)) {
  const states = journeyStates(),
    result = await evaluate({
      state: { menu: drinkMenu, states },
      questions: journeyQuestions(states),
    });
  writeFileSync(
    path,
    JSON.stringify(
      {
        manifest: {
          experiment: "journeys",
          created: new Date().toISOString(),
          status: "complete",
        },
        result: { ...result, states },
      },
      null,
      2,
    ),
  );
  console.log("81 adaptive journey decisions recorded.");
}
