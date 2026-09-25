/**
 * The three native question builders upstream imports from @typesafe-ai/sdk, producing the
 * wire shape our gateway accepts. Upstream's questions.ts is vendored with only its import
 * pointed here, so the question text is exactly upstream's.
 */
export type WireQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export const choice = <const K extends string>(instructions: string, criteria: Record<K, string>) =>
  ({ type: "choice", instructions, criteria }) satisfies WireQuestion;

export const noul = (instructions: string) =>
  ({ type: "noul", instructions }) satisfies WireQuestion;

export const score = (instructions: string, criteria: string[]) =>
  ({ type: "score", instructions, criteria }) satisfies WireQuestion;
