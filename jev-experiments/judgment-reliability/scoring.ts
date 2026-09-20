export type Vote = "A" | "B" | "tie" | null;
export function canonical(vote: Vote, swap: boolean): Vote { return swap && vote && vote !== "tie" ? vote === "A" ? "B" : "A" : vote; }
export function rank(a?: number | null, b?: number | null): Vote { return a == null || b == null ? null : a === b ? "tie" : a > b ? "A" : "B"; }
export function official(normal: Vote, reversedDisplayed: Vote, gold: "A" | "B") {
  const reverse = canonical(reversedDisplayed, true);
  const signed = (v: Vote) => v === gold ? 1 : v === (gold === "A" ? "B" : "A") ? -1 : 0;
  const sum = signed(normal) + signed(reverse);
  return { outcome: sum > 0 ? "correct" : sum < 0 ? "incorrect" : "tie", correct: sum > 0 ? 1 : 0, nulls: normal == null || reversedDisplayed == null, inconsistent: normal !== reverse };
}
export function transitions(votes: Vote[]) {
  const observed = votes.filter(v => v != null), winners = new Set(observed.filter(v => v !== "tie"));
  return { complete: observed.length === votes.length, identity_flip: winners.size > 1, tie_transition: observed.includes("tie") && winners.size > 0, decision_changed: new Set(observed).size > 1 };
}
export function range(values: (number | null | undefined)[]) { const xs = values.filter((n): n is number => n != null); return xs.length ? Math.max(...xs) - Math.min(...xs) : null; }
export function compareVotes(a: Vote, b: Vote) { return { complete: a != null && b != null, identity_flip: a != null && b != null && a !== "tie" && b !== "tie" && a !== b, tie_transition: a != null && b != null && (a === "tie") !== (b === "tie"), any_change: a != null && b != null && a !== b }; }
