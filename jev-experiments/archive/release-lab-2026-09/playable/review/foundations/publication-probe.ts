import { assertPreserved as check } from "../../../verification/record-integrity";
// Runs the production preservation check without generating publication files.
const cases = [
  {
    name: "empty-object-replaced-with-null",
    source: { metadata: {} },
    output: { metadata: null },
  },
  {
    name: "empty-object-replaced-with-number",
    source: { metadata: {} },
    output: { metadata: 42 },
  },
  {
    name: "empty-array-replaced-with-object",
    source: { rows: [] },
    output: { rows: {} },
  },
];
console.log(
  JSON.stringify(
    cases.map((c) => {
      try {
        check(c.source, c.output);
        return { name: c.name, accepted: true };
      } catch (error) {
        return { name: c.name, accepted: false, error: String(error) };
      }
    }),
    null,
    2,
  ),
);
