import { predict } from "../web/src/local-classifier";
const input = JSON.parse(await Bun.stdin.text());
console.log(
  JSON.stringify(input.texts.map((text: string) => predict(input.model, text))),
);
