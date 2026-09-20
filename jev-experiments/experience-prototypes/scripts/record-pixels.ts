import "./credentials";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluate } from "../server/gateway";
import { pixelQuestions } from "../src/creative";
const path = "results/visuals.json",
  doc = JSON.parse(readFileSync(path, "utf8"));
doc.result.compositions ??= [];
for (const [mode, brief] of [
  [
    "scenes",
    "A tiny noodle shop on a rainy street at midnight, with one warm window and a cat under the awning.",
  ],
  ["sprites", "A friendly gardening robot with warm eyes, as a game sprite."],
  ["patterns", "An ocean-like field of slowly changing colors."],
]) {
  if (doc.result.compositions.some((r: any) => r.mode === mode)) continue;
  const response = await evaluate({
    state: { brief, mode },
    questions: pixelQuestions(mode),
  });
  const objectTypes = [
    "house",
    "tree",
    "cat",
    "robot",
    "flower",
    "pond",
    "mountain",
    "moon",
    "cloud",
  ];
  const plan = Object.fromEntries(
    Object.entries(response.answers).map(([k, a]) => [
      k,
      objectTypes.includes(k) ? a.value >= 0.5 : a.value,
    ]),
  );
  doc.result.compositions.push({ mode, brief, plan, ...response });
  writeFileSync(path, JSON.stringify(doc, null, 2));
  console.log(mode + " composition saved");
}
