/**
 * SGLang's System One answers (noul / choice / score with x_label_mass) in the wire shape our
 * recordings already use for Jev and Laya: { type, value, probabilities, confidence }.
 */
export type Raw = {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  x_label_mass?: number;
};

export type WireAnswer = {
  type: string;
  value: unknown;
  probabilities: Record<string, number> | null;
  confidence?: number;
  /** Full-vocabulary probability of the answer labels (SGLang's label_mass). */
  labelMass?: number;
};

export function toWire(raw: Record<string, Raw>): Record<string, WireAnswer> {
  return Object.fromEntries(
    Object.entries(raw).map(([k, a]): [string, WireAnswer] => {
      if (a.type === "noul") {
        const p = a.noul ?? 0;

        return [k, { type: "noul", value: p, probabilities: { false: 1 - p, true: p }, labelMass: a.x_label_mass }];
      }

      return [
        k,
        {
          type: a.type,
          value: a.type === "choice" ? a.choice : a.score,
          probabilities: a.probabilities ?? null,
          confidence: a.confidence,
          labelMass: a.x_label_mass,
        },
      ];
    }),
  );
}
