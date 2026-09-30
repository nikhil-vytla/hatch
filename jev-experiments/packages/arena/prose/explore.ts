/**
 * Post-hoc look-ups written after the frozen analysis ran: concrete examples behind the
 * headline numbers. Nothing here changes a pre-registered metric; the README marks every
 * number from this script as exploratory.
 *
 *   bun jev-experiments/packages/arena/prose/explore.ts
 */
import { loadRows } from "./analyze";
import { pClaim, type Answers } from "./metrics";
import { allJobs } from "./variants";

const rows = loadRows(new URL(".", import.meta.url));
const jobs = new Map(allJobs().map((j) => [j.id, j]));
const ans = new Map<string, Answers>();

for (const r of rows) if (r.status === "ok" && !r.rejected?.length) ans.set(r.id, r.answers!);

const p = (id: string) => {
  const a = ans.get(id);
  const j = jobs.get(id);

  return a && j ? pClaim(j.read, a) : NaN;
};
const raw = (id: string) => Number(ans.get(id)?.q?.value);
const f = (x: number) => x.toFixed(2);

for (const study of ["claim-truth", "claim-ambiguous"]) {
  const items = [...new Set([...jobs.values()].filter((j) => j.study === study).map((j) => j.item))];

  console.log(`\n## ${study}`);

  for (const v of ["lexical-syntax:center-embedded", "suggestion:most-say-no", "suggestion:most-say-yes", "noise:typos-heavy", "hedge-intensifier:intensifier", "negation:is-it-false", "negation:double-not-the-case", "stakes-persona:persona-lenient"]) {
    const lines = items.map((it) => {
      const j = jobs.get(`${study}:${it}:baseline:canonical`)!;
      const c = p(`${study}:${it}:baseline:canonical`);
      const x = p(`${study}:${it}:${v}`);

      return { it, truth: j.truth, c, x, d: x - c };
    });

    console.log(`\n${v}: P(claim) canonical → variant (truth)`);
    for (const l of lines.filter((l) => Math.abs(l.d) > 0.1).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)))
      console.log(`  ${l.it} (${l.truth ?? "?"}): ${f(l.c)} → ${f(l.x)}`);

    if (study === "claim-truth") {
      const t = lines.filter((l) => l.truth === true);
      const fa = lines.filter((l) => l.truth === false);
      const m = (xs: typeof lines) => xs.reduce((s, l) => s + l.d, 0) / xs.length;

      console.log(`  mean Δ P(claim): true items ${f(m(t))}, false items ${f(m(fa))}`);
    }
  }

  // Items where any complementary pair is off by more than 0.2.
  const pairs = [
    ["baseline:canonical", "negation:is-it-false"],
    ["sentence-form:is-it-true", "negation:negated-claim"],
    ["sentence-form:declarative", "negation:negated-declarative"],
    ["acquiescence:agree-claim", "acquiescence:agree-negated"],
    ["suggestion:expert-claim", "suggestion:expert-negated"],
    ["presupposition:given-claim", "presupposition:given-negated"],
  ];
  const failing = items.filter((it) => pairs.some(([a, b]) => Math.abs(raw(`${study}:${it}:${a}`) + raw(`${study}:${it}:${b}`) - 1) > 0.2));

  console.log(`\nItems with any pair off by > 0.2: ${failing.length} of ${items.length}: ${failing.join(", ")}`);
  for (const it of failing)
    for (const [a, b] of pairs) {
      const s = raw(`${study}:${it}:${a}`) + raw(`${study}:${it}:${b}`);

      if (Math.abs(s - 1) > 0.2)
        console.log(`  ${it}: ${a} ${f(raw(`${study}:${it}:${a}`))} + ${b} ${f(raw(`${study}:${it}:${b}`))} = ${f(s)}`);
    }
}

// Where the three content failures stand across every form.
for (const it of ["refund", "hotel", "password"]) {
  const right = [...jobs.values()].filter((j) => j.study === "claim-truth" && j.item === it && ans.has(j.id)).filter((j) => {
    const x = p(j.id);

    return (j.truth ? x : 1 - x) > 0.5;
  });

  console.log(`\n${it}: right under ${right.length} forms: ${right.map((j) => `${j.family}:${j.variant} (${f(p(j.id))})`).join(", ")}`);
}

// Choice: each-yes/no sums, and which item the canonical choice gets wrong.
for (const j of jobs.values())
  if (j.study === "choice" && j.variant === "canonical") {
    const a = ans.get(j.id)!;
    const probs = a.q!.probabilities!;
    const top = Object.entries(probs).sort((x, y) => y[1] - x[1])[0]!;

    if (top[0] !== j.truth) console.log(`\nchoice wrong: ${j.item}: picked ${top[0]} ${f(top[1])}, right ${j.truth} ${f(probs[j.truth as string] ?? 0)}`);
  }

const each = [...jobs.values()].filter((j) => j.study === "choice" && j.variant === "yes-no-each");
const sums = each.map((j) => Object.values(ans.get(j.id)!).reduce((s, a) => s + Number(a.value), 0));

console.log(`\nyes-no-each: sum of P(yes) over the 4 options, mean ${f(sums.reduce((s, x) => s + x, 0) / sums.length)}, min ${f(Math.min(...sums))}, max ${f(Math.max(...sums))}`);

// Framing: P(Program B) overall.
const framing = [...jobs.values()].filter((j) => j.study === "framing");
const pb = framing.map((j) => ans.get(j.id)!.q!.probabilities!["Program B"]!);

console.log(`\nframing: mean P(Program B) ${f(pb.reduce((s, x) => s + x, 0) / pb.length)} over ${pb.length}; B chosen in ${pb.filter((x) => x > 0.5).length}`);
