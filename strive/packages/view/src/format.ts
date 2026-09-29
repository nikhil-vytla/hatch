import type { LearningSignalsResult } from "@strive/protocol";

/** `$D.DDDD`, rounded up so a nonzero cost never shows as zero. Matches the daemon's format. */
export function formatUsd(micros: number): string {
  const units = Math.ceil(micros / 100);

  return `$${Math.floor(units / 10_000)}.${String(units % 10_000).padStart(4, "0")}`;
}

/** `$D.DD`, rounded up: an estimate, where four places would claim a precision it hasn't. */
function roughUsd(micros: number): string {
  const cents = Math.ceil(micros / 10_000);

  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * The offer to learn from a session with signs: "This session had 2
 * corrections. Learn from it? It costs a learner run, about $0.07." The
 * price is the project's average run; before its first run there's none.
 */
export function offerText(subject: string, r: LearningSignalsResult): string {
  const price = r.estimateUsdMicros === undefined ? "" : `, about ${roughUsd(r.estimateUsdMicros)}`;

  return `${subject} had ${r.summary}. Learn from it? It costs a learner run${price}.`;
}
