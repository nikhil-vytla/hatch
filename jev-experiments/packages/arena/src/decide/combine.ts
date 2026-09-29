/**
 * Turns a model's answers to a setup's questions into a distribution over the visitor's
 * options, by the setup's combine rule. Answers arrive in the gateway's wire format: a choice
 * carries probabilities per key, a yes/no its P(true) as `value`, a score probabilities per
 * level index.
 */
import { z } from "zod";
import type { Combine, Option } from "./deck";

export const wireAnswerSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  probabilities: z.record(z.string(), z.number()).nullable(),
});

export type WireAnswer = z.infer<typeof wireAnswerSchema>;

export type Dist = Record<string, number>;

const pYes = (a: WireAnswer | undefined) => {
  if (!a) return 0.5;

  if (a.probabilities && "true" in a.probabilities) return a.probabilities.true;

  return z.number().catch(0.5).parse(a.value);
};

function normalised(options: Option[], raw: Dist): Dist {
  const total = options.reduce((s, o) => s + Math.max(0, raw[o.id] ?? 0), 0);

  return Object.fromEntries(
    options.map((o) => [
      o.id,
      total > 0 ? Math.max(0, raw[o.id] ?? 0) / total : 1 / options.length,
    ]),
  );
}

/** `yes` gets p; the other options share 1 − p evenly. */
function binary(options: Option[], yes: string, p: number): Dist {
  const rest = (1 - p) / Math.max(1, options.length - 1);

  return Object.fromEntries(options.map((o) => [o.id, o.id === yes ? p : rest]));
}

export function combine(
  rule: Combine,
  options: Option[],
  answers: Record<string, WireAnswer>,
): Dist {
  switch (rule.rule) {
    case "choice":
      return normalised(options, answers[rule.question]?.probabilities ?? {});

    case "yes":
      return binary(options, rule.yes, pYes(answers[rule.question]));

    case "score": {
      const levels = answers[rule.question]?.probabilities ?? {};
      const raw: Dist = {};

      rule.levels.forEach((option, i) => {
        const p = levels[String(i)] ?? 0;
        // A level with no option is a shrug: its weight is shared evenly.
        const targets = option ? [option] : options.map((o) => o.id);

        for (const t of targets) raw[t] = (raw[t] ?? 0) + p / targets.length;
      });

      return normalised(options, raw);
    }

    case "each":
      return normalised(
        options,
        Object.fromEntries(
          Object.entries(rule.questions).map(([option, q]) => [option, pYes(answers[q])]),
        ),
      );

    case "all":
      return binary(
        options,
        rule.yes,
        rule.questions.reduce((p, q) => p * pYes(answers[q]), 1),
      );

    case "any":
      return binary(
        options,
        rule.yes,
        1 - rule.questions.reduce((p, q) => p * (1 - pYes(answers[q])), 1),
      );
  }
}

/** The option a distribution favours; ties keep option order. */
export const topOf = (options: Option[], d: Dist) =>
  options.reduce((best, o) => ((d[o.id] ?? 0) > (d[best.id] ?? 0) ? o : best), options[0]);

/** A combine rule written out the way the page shows it. */
export function describe(rule: Combine, options: Option[]): string {
  const label = (id: string) => options.find((o) => o.id === id)?.label ?? id;

  const other = (id: string) => options.flatMap((o) => (o.id === id ? [] : [o.label])).join(" / ");

  switch (rule.rule) {
    case "choice":
      return `P(option) = the choice's probability for that option`;

    case "yes":
      return `P(${label(rule.yes)}) = P(yes); ${other(rule.yes)} share 1 − P(yes)`;

    case "score":
      return rule.levels.map((o, i) => `level ${i} → ${o ? label(o) : "split evenly"}`).join("; ");

    case "each":
      return `P(option) = P(yes) for that option's question, renormalised`;

    case "all":
      return `P(${label(rule.yes)}) = ${rule.questions.map((q) => `P(${q})`).join(" × ")}`;

    case "any":
      return `P(${label(rule.yes)}) = 1 − ${rule.questions.map((q) => `(1 − P(${q}))`).join(" × ")}`;
  }
}
