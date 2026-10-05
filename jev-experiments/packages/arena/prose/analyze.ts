/**
 * The frozen analysis for the prose studies. Reads the recording, rebuilds every job from
 * `variants.ts`, and writes `results.md` (tables) and `results.json` (every number).
 *
 *   bun jev-experiments/packages/arena/prose/analyze.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  argmax,
  binaryCredit,
  calibration,
  credit,
  dist,
  expected,
  mean,
  pClaim,
  side,
  tv,
  type Answers,
} from "./metrics";
import { allJobs, type Job } from "./variants";
import { bootstrapMean } from "../../seeded/src/index";

export type Recorded = {
  id: string;
  status: string;
  answers?: Answers;
  rejected?: { question_id: string }[];
  latencyMs?: number;
  servedBy?: string | null;
  inputTokens?: number | null;
  costUsd?: number | null;
  at?: string;
  code?: number;
};

export function loadRows(dir: URL): Recorded[] {
  const raw = new URL("./recordings/prose.jsonl", dir);
  const gz = new URL("./recordings/prose.jsonl.gz", dir);
  const text = existsSync(raw)
    ? readFileSync(raw, "utf8")
    : existsSync(gz)
      ? gunzipSync(readFileSync(gz)).toString("utf8")
      : "";

  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "—");
const signed = (x: number, d = 3) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}` : "—");
const ci = ([lo, hi]: [number, number], d = 3) => `[${signed(lo, d)}, ${signed(hi, d)}]`;

type Cell = { job: Job; answers: Answers };

export function analyse(rows: Recorded[]) {
  const jobs = allJobs();
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const ok = new Map<string, Recorded>();

  for (const r of rows) if (r.status === "ok" && byId.has(r.id)) ok.set(r.id, r);

  const cells = new Map<string, Cell>();
  const rejected: string[] = [];

  // A request whose only question is a rejected Score is logged with status "rejected".
  for (const r of rows) if (r.status === "rejected" && byId.has(r.id) && !rejected.includes(r.id)) rejected.push(r.id);

  for (const [id, r] of ok) {
    if (r.rejected?.length) {
      rejected.push(id);
      continue;
    }
    cells.set(id, { job: byId.get(id)!, answers: r.answers! });
  }

  const get = (study: string, item: string, family: string, variant: string) =>
    cells.get(`${study}:${item}:${family}:${variant}`);
  const md: string[] = [];
  const json: Record<string, unknown> = {};

  // ---------- run summary ----------
  const attempts = rows.filter((r) => !(r as { note?: string }).note).length;
  const busy = rows.filter((r) => r.status === "error" && r.code !== 502).length;
  const lat = [...ok.values()].map((r) => r.latencyMs ?? NaN).filter(Number.isFinite).sort((a, b) => a - b);
  const hosts: Record<string, number> = {};

  for (const r of ok.values()) hosts[r.servedBy ?? "unknown"] = (hosts[r.servedBy ?? "unknown"] ?? 0) + 1;

  const cost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const unknownCost = [...ok.values()].filter((r) => r.costUsd == null).length;
  const tokens = [...ok.values()].reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const dates = [...ok.values()].map((r) => r.at!).sort();
  const run = {
    jobs: jobs.length,
    answered: ok.size + rows.filter((r) => r.status === "rejected").length,
    rejected: rejected.length,
    attempts,
    errors: busy,
    errorCodes: rows.filter((r) => r.status === "error" && r.code !== 502).reduce<Record<string, number>>((m, r) => ((m[String(r.code)] = (m[String(r.code)] ?? 0) + 1), m), {}),
    costUsd: cost,
    unknownCost,
    inputTokens: tokens,
    hosts,
    latencyMs: { p50: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)] },
    first: dates[0],
    last: dates.at(-1),
  };

  json.run = run;
  md.push(
    "## Run",
    "",
    `${run.answered} of ${run.jobs} requests answered (${run.rejected} with a rejected Score), ${run.attempts} attempts, ${run.errors} busy or failed attempts (${Object.entries(run.errorCodes).map(([c, n]) => `${c}: ${n}`).join(", ") || "none"}).`,
    `Reported cost $${cost.toFixed(6)} (${unknownCost} answers without a reported cost), ${tokens.toLocaleString("en")} input tokens. Hosts: ${Object.entries(hosts).map(([h, n]) => `${h} ${n}`).join(", ")}. Service latency p50 ${run.latencyMs.p50} ms, p90 ${run.latencyMs.p90} ms. First answer ${run.first}, last ${run.last}.`,
    "",
  );

  // ---------- claims ----------
  for (const study of ["claim-truth", "claim-ambiguous"] as const) {
    const truthful = study === "claim-truth";
    const items = [...new Set(jobs.filter((j) => j.study === study).map((j) => j.item))];
    const variants = [...new Map(jobs.filter((j) => j.study === study).map((j) => [`${j.family}:${j.variant}`, j])).values()];
    const pc = (item: string, family: string, variant: string) => {
      const c = get(study, item, family, variant);

      return c ? pClaim(c.job.read, c.answers) : NaN;
    };
    const pCorrect = (item: string, p: number) => {
      const j = jobs.find((x) => x.study === study && x.item === item)!;

      return j.truth === true ? p : 1 - p;
    };
    const table: Record<string, unknown>[] = [];

    md.push(`## ${truthful ? "Yes/no with a right answer" : "Debatable yes/no"} (${items.length} items)`, "");
    md.push(
      truthful
        ? "| Family | Variant | n | Accuracy | Mean P(right) | Δ P(right) vs canonical [95% CI] | Flips | Mean shift [95% CI] |"
        : "| Family | Variant | n | Mean P(claim) | Δ P(claim) vs canonical [95% CI] | Flips | Mean shift [95% CI] |",
      truthful ? "| --- | --- | --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- | --- | --- | --- |",
    );

    for (const v of variants) {
      const pairs = items
        .map((it) => ({ it, p: pc(it, v.family, v.variant), c: pc(it, "baseline", "canonical") }))
        .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.c));
      const flips = pairs.filter((x) => side(x.p) !== side(x.c)).length;
      const shifts = pairs.map((x) => Math.abs(x.p - x.c));
      const seed = 7;
      const row: Record<string, unknown> = {
        family: v.family,
        variant: v.variant,
        n: pairs.length,
        flips,
        shift: mean(shifts),
        shiftCI: bootstrapMean(shifts, seed),
      };

      if (truthful) {
        const right = pairs.map((x) => pCorrect(x.it, x.p));
        const deltas = pairs.map((x) => pCorrect(x.it, x.p) - pCorrect(x.it, x.c));

        Object.assign(row, {
          accuracy: mean(right.map(binaryCredit)),
          pRight: mean(right),
          delta: mean(deltas),
          deltaCI: bootstrapMean(deltas, seed),
        });
        md.push(
          `| ${v.family} | ${v.variant} | ${pairs.length} | ${pct(row.accuracy as number)} | ${f2(row.pRight as number)} | ${signed(row.delta as number)} ${ci(row.deltaCI as [number, number])} | ${flips} | ${f3(row.shift as number)} ${ci(row.shiftCI as [number, number])} |`,
        );
      } else {
        const deltas = pairs.map((x) => x.p - x.c);

        Object.assign(row, { pClaim: mean(pairs.map((x) => x.p)), delta: mean(deltas), deltaCI: bootstrapMean(deltas, seed) });
        md.push(
          `| ${v.family} | ${v.variant} | ${pairs.length} | ${f2(row.pClaim as number)} | ${signed(row.delta as number)} ${ci(row.deltaCI as [number, number])} | ${flips} | ${f3(row.shift as number)} ${ci(row.shiftCI as [number, number])} |`,
        );
      }

      table.push(row);
    }

    md.push("");

    // Family roll-up: every item × variant in the family, excluding the canonical itself.
    md.push("Family roll-up (each item × variant against the same item's canonical answer):", "");
    md.push(
      truthful
        ? "| Family | Cells | Accuracy | Flip rate | Mean shift |"
        : "| Family | Cells | Flip rate | Mean shift |",
      truthful ? "| --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- |",
    );

    const families = [...new Set(variants.map((v) => v.family))];
    const rollup: Record<string, unknown>[] = [];

    for (const fam of families) {
      const cellsIn = variants
        .filter((v) => v.family === fam && v.variant !== "canonical")
        .flatMap((v) => items.map((it) => ({ it, p: pc(it, v.family, v.variant), c: pc(it, "baseline", "canonical") })))
        .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.c));
      const r = {
        family: fam,
        cells: cellsIn.length,
        accuracy: truthful ? mean(cellsIn.map((x) => binaryCredit(pCorrect(x.it, x.p)))) : NaN,
        flipRate: mean(cellsIn.map((x) => (side(x.p) !== side(x.c) ? 1 : 0))),
        shift: mean(cellsIn.map((x) => Math.abs(x.p - x.c))),
      };

      rollup.push(r);
      md.push(
        truthful
          ? `| ${fam} | ${r.cells} | ${pct(r.accuracy)} | ${pct(r.flipRate)} | ${f3(r.shift)} |`
          : `| ${fam} | ${r.cells} | ${pct(r.flipRate)} | ${f3(r.shift)} |`,
      );
    }

    md.push("");

    // Invariance: pairs of raw yes/no answers that should sum to one (or show a yes bias).
    const raw = (item: string, family: string, variant: string) => {
      const c = get(study, item, family, variant);

      return c && c.job.read.kind === "noul" ? Number(c.answers.q!.value) : NaN;
    };
    const pairsDef: [string, [string, string], [string, string]][] = [
      ["question / is it false", ["baseline", "canonical"], ["negation", "is-it-false"]],
      ["is it true / is it true (negated)", ["sentence-form", "is-it-true"], ["negation", "negated-claim"]],
      ["declarative / negated declarative", ["sentence-form", "declarative"], ["negation", "negated-declarative"]],
      ["agree / agree (negated)", ["acquiescence", "agree-claim"], ["acquiescence", "agree-negated"]],
      ["expert says / expert says (negated)", ["suggestion", "expert-claim"], ["suggestion", "expert-negated"]],
      ["given / given (negated)", ["presupposition", "given-claim"], ["presupposition", "given-negated"]],
    ];
    const inv: Record<string, unknown>[] = [];

    md.push(
      "Complementary pairs: P(yes | X) + P(yes | not-X) should be 1. Above 1 is a yes bias.",
      "",
      "| Pair | n | Mean P(yes|X) + P(yes|not-X) − 1 [95% CI] | Mean |sum − 1| | Pairs off by > 0.2 | Pairs where both answers are the same side |",
      "| --- | --- | --- | --- | --- | --- |",
    );

    for (const [label, [fa, va], [fb, vb]] of pairsDef) {
      const xs = items
        .map((it) => ({ it, a: raw(it, fa, va), b: raw(it, fb, vb) }))
        .filter((x) => Number.isFinite(x.a) && Number.isFinite(x.b));
      const bias = xs.map((x) => x.a + x.b - 1);
      const r = {
        pair: label,
        n: xs.length,
        bias: mean(bias),
        biasCI: bootstrapMean(bias, 11),
        absDev: mean(bias.map(Math.abs)),
        over02: bias.filter((b) => Math.abs(b) > 0.2).length,
        sameSide: xs.filter((x) => side(x.a) === side(x.b) && side(x.a) !== 0).length,
        worst: xs
          .map((x) => ({ item: x.it, a: x.a, b: x.b, dev: x.a + x.b - 1 }))
          .sort((p, q) => Math.abs(q.dev) - Math.abs(p.dev))
          .slice(0, 3),
      };

      inv.push(r);
      md.push(`| ${label} | ${r.n} | ${signed(r.bias)} ${ci(r.biasCI)} | ${f3(r.absDev)} | ${r.over02} | ${r.sameSide} |`);
    }

    md.push("");

    // Suggestion and persona contrasts on raw P(yes).
    const contrasts: [string, [string, string], [string, string]][] = [
      ["most say yes − most say no", ["suggestion", "most-say-yes"], ["suggestion", "most-say-no"]],
      ["strict auditor − lenient friend", ["stakes-persona", "persona-strict"], ["stakes-persona", "persona-lenient"]],
      ["answer yes-or-no − no-or-yes", ["sentence-form", "answer-yes-or-no"], ["sentence-form", "answer-no-or-yes"]],
    ];
    const con: Record<string, unknown>[] = [];

    md.push("| Contrast (raw P(yes)) | n | Mean difference [95% CI] | Items moved > 0.1 in the named direction |", "| --- | --- | --- | --- |");

    for (const [label, [fa, va], [fb, vb]] of contrasts) {
      const d = items
        .map((it) => raw(it, fa, va) - raw(it, fb, vb))
        .filter(Number.isFinite);
      const r = { contrast: label, n: d.length, mean: mean(d), ci: bootstrapMean(d, 13), moved: d.filter((x) => x > 0.1).length };

      con.push(r);
      md.push(`| ${label} | ${r.n} | ${signed(r.mean)} ${ci(r.ci)} | ${r.moved} |`);
    }

    md.push("");

    let calib: ReturnType<typeof calibration> | undefined;
    let perItem: Record<string, unknown>[] = [];

    let languages: Record<string, unknown>[] = [];

    if (truthful) {
      // Question-only translations against the English canonical (same JSON state); full
      // translations against the English prose state, which is what they translate.
      const langs = [...new Set(variants.filter((v) => v.family === "language-question").map((v) => v.variant))];

      languages = langs.map((lang) => {
        const q = items.map((it) => pCorrect(it, pc(it, "language-question", lang)) - pCorrect(it, pc(it, "baseline", "canonical"))).filter(Number.isFinite);
        const full = items.map((it) => pCorrect(it, pc(it, "language-full", lang)) - pCorrect(it, pc(it, "representation", "prose"))).filter(Number.isFinite);
        const accQ = mean(items.map((it) => binaryCredit(pCorrect(it, pc(it, "language-question", lang)))).filter(Number.isFinite));
        const accF = mean(items.map((it) => binaryCredit(pCorrect(it, pc(it, "language-full", lang)))).filter(Number.isFinite));

        return { lang, accQuestion: accQ, deltaQuestion: mean(q), ciQuestion: bootstrapMean(q, 67), accFull: accF, deltaFull: mean(full), ciFull: bootstrapMean(full, 71) };
      });
      md.push(
        "Languages: question translated (JSON facts in English) vs the English canonical; question and facts translated vs English prose facts.",
        "",
        "| Language | Accuracy, question only | Δ P(right) vs English [95% CI] | Accuracy, all translated | Δ P(right) vs English prose [95% CI] |",
        "| --- | --- | --- | --- | --- |",
        ...languages.map((r) => {
          const x = r as { lang: string; accQuestion: number; deltaQuestion: number; ciQuestion: [number, number]; accFull: number; deltaFull: number; ciFull: [number, number] };

          return `| ${x.lang} | ${pct(x.accQuestion)} | ${signed(x.deltaQuestion)} ${ci(x.ciQuestion)} | ${pct(x.accFull)} | ${signed(x.deltaFull)} ${ci(x.ciFull)} |`;
        }),
        "",
      );
    }

    if (truthful) {
      const points = [...cells.values()]
        .filter((c) => c.job.study === study)
        .map((c) => {
          const p = pCorrect(c.job.item, pClaim(c.job.read, c.answers));

          return { confidence: Math.max(p, 1 - p), correct: binaryCredit(p) };
        });

      calib = calibration(points);
      md.push(
        `Calibration over all ${points.length} yes/no answers with a right answer (confidence = max(P, 1 − P)): expected calibration error ${f3(calib.ece)}.`,
        "",
        "| Stated confidence | n | Mean confidence | Accuracy |",
        "| --- | --- | --- | --- |",
        ...calib.bins.filter((b) => b.n).map((b) => `| ${pct(b.from)}–${pct(b.to)} | ${b.n} | ${f2(b.confidence)} | ${pct(b.accuracy)} |`),
        "",
      );

      perItem = items.map((it) => {
        const own = [...cells.values()].filter((c) => c.job.study === study && c.job.item === it);
        const ps = own.map((c) => pCorrect(it, pClaim(c.job.read, c.answers)));

        return {
          item: it,
          cells: own.length,
          canonical: pCorrect(it, pc(it, "baseline", "canonical")),
          accuracy: mean(ps.map(binaryCredit)),
          wrong: own.filter((c) => binaryCredit(pCorrect(it, pClaim(c.job.read, c.answers))) < 1).map((c) => `${c.job.family}:${c.job.variant}`),
        };
      });
      md.push("Per item (all variants):", "", "| Item | Cells | P(right), canonical | Accuracy across variants |", "| --- | --- | --- | --- |");
      for (const r of perItem as { item: string; cells: number; canonical: number; accuracy: number }[])
        md.push(`| ${r.item} | ${r.cells} | ${f2(r.canonical)} | ${pct(r.accuracy)} |`);
      md.push("");
    }

    json[study] = { variants: table, rollup, invariance: inv, contrasts: con, languages, calibration: calib, perItem };
  }

  // ---------- choice ----------
  {
    const study = "choice";
    const items = [...new Set(jobs.filter((j) => j.study === study).map((j) => j.item))];
    const variants = [...new Map(jobs.filter((j) => j.study === study).map((j) => [`${j.family}:${j.variant}`, j])).values()];
    const d = (item: string, family: string, variant: string) => {
      const c = get(study, item, family, variant);

      return c ? dist(c.job.read, c.answers) : undefined;
    };
    const truth = (item: string) => jobs.find((j) => j.study === study && j.item === item)!.truth as string;
    const table: Record<string, unknown>[] = [];

    md.push(`## Choice with a right answer (${items.length} items, 4 options)`, "");
    md.push("| Family | Variant | n | Accuracy | Mean P(right) | Δ P(right) vs canonical [95% CI] | Top answer changed | Mean TV vs canonical |", "| --- | --- | --- | --- | --- | --- | --- | --- |");

    for (const v of variants) {
      const xs = items
        .map((it) => ({ it, p: d(it, v.family, v.variant), c: d(it, "baseline", "canonical") }))
        .filter((x) => x.p && x.c) as { it: string; p: Record<string, number>; c: Record<string, number> }[];
      const right = xs.map((x) => x.p[truth(x.it)] ?? 0);
      const deltas = xs.map((x) => (x.p[truth(x.it)] ?? 0) - (x.c[truth(x.it)] ?? 0));
      const sameKeys = (x: { p: Record<string, number>; c: Record<string, number> }) =>
        Object.keys(x.p).length === Object.keys(x.c).length && Object.keys(x.p).every((k) => k in x.c);
      const tvs = xs.filter(sameKeys).map((x) => tv(x.p, x.c));
      const row = {
        family: v.family,
        variant: v.variant,
        n: xs.length,
        accuracy: mean(xs.map((x) => credit(x.p, truth(x.it)))),
        pRight: mean(right),
        delta: mean(deltas),
        deltaCI: bootstrapMean(deltas, 17),
        changed: xs.filter((x) => argmax(x.p) !== argmax(x.c)).length,
        tv: tvs.length ? mean(tvs) : NaN,
      };

      table.push(row);
      md.push(`| ${v.family} | ${v.variant} | ${row.n} | ${pct(row.accuracy)} | ${f2(row.pRight)} | ${signed(row.delta)} ${ci(row.deltaCI)} | ${row.changed} | ${f3(row.tv)} |`);
    }

    md.push("");

    // Position: P(right) by where the right option was listed, and P(first listed option).
    const byPos = [1, 2, 3, 4].map((k) => {
      const ps = items.map((it) => d(it, "position", `correct-at-${k}`)?.[truth(it)]).filter((x): x is number => x !== undefined);

      return { position: k, n: ps.length, pRight: mean(ps), accuracy: mean(items.map((it) => { const p = d(it, "position", `correct-at-${k}`); return p ? credit(p, truth(it)) : NaN; }).filter(Number.isFinite)) };
    });
    const firstLast = items
      .map((it) => (d(it, "position", "correct-at-1")?.[truth(it)] ?? NaN) - (d(it, "position", "correct-at-4")?.[truth(it)] ?? NaN))
      .filter(Number.isFinite);

    md.push(
      "Position of the right option (same options, the right one moved):",
      "",
      "| Right option listed | n | Accuracy | Mean P(right) |",
      "| --- | --- | --- | --- |",
      ...byPos.map((r) => `| ${r.position} | ${r.n} | ${pct(r.accuracy)} | ${f2(r.pRight)} |`),
      "",
      `P(right) listed first − listed last: ${signed(mean(firstLast))} ${ci(bootstrapMean(firstLast, 19))} over ${firstLast.length} items.`,
      "",
    );
    json.choice = { variants: table, position: byPos, firstMinusLast: { mean: mean(firstLast), ci: bootstrapMean(firstLast, 19) } };
  }

  // ---------- framing ----------
  {
    const items = [...new Set(jobs.filter((j) => j.study === "framing").map((j) => j.item))];
    const pSure = (item: string, frame: string, order: string) => {
      const c = cells.get(`framing:${item}:${frame}:${order}`);

      return c ? dist(c.job.read, c.answers).sure! : NaN;
    };
    const rows2 = items.map((it) => {
      const gain = mean([pSure(it, "gain", "sure-first"), pSure(it, "gain", "risky-first")]);
      const loss = mean([pSure(it, "loss", "sure-first"), pSure(it, "loss", "risky-first")]);
      const orderEffect = mean([
        pSure(it, "gain", "sure-first") - pSure(it, "gain", "risky-first"),
        pSure(it, "loss", "sure-first") - pSure(it, "loss", "risky-first"),
      ]);

      return { item: it, gain, loss, effect: gain - loss, orderEffect };
    }).filter((r) => Number.isFinite(r.effect));
    const effect = rows2.map((r) => r.effect);
    const order = rows2.map((r) => r.orderEffect);

    md.push(
      "## Risky-choice framing (Tversky & Kahneman 1981)",
      "",
      "P(sure option), averaged over both option orders. People pick the sure option more in the gain frame.",
      "",
      "| Scenario | Gain frame | Loss frame | Gain − loss | Listed first − listed second |",
      "| --- | --- | --- | --- | --- |",
      ...rows2.map((r) => `| ${r.item} | ${f2(r.gain)} | ${f2(r.loss)} | ${signed(r.effect, 2)} | ${signed(r.orderEffect, 2)} |`),
      "",
      `Framing effect (gain − loss): ${signed(mean(effect))} ${ci(bootstrapMean(effect, 23))}, ${effect.filter((x) => x > 0).length} of ${effect.length} scenarios in the human direction. Order effect (sure option listed first − second): ${signed(mean(order))} ${ci(bootstrapMean(order, 29))}.`,
      "",
    );
    json.framing = { scenarios: rows2, effect: { mean: mean(effect), ci: bootstrapMean(effect, 23) }, order: { mean: mean(order), ci: bootstrapMean(order, 29) } };
  }

  // ---------- attribute framing ----------
  {
    const items = [...new Set(jobs.filter((j) => j.study === "attribute").map((j) => j.item))];
    const e = (item: string, frame: string) => {
      const c = cells.get(`attribute:${item}:${frame}`);

      return c ? expected(dist(c.job.read, c.answers)) : NaN;
    };
    const rows2 = items.map((it) => ({ item: it, positive: e(it, "positive"), negative: e(it, "negative") })).filter((r) => Number.isFinite(r.positive - r.negative));
    const d = rows2.map((r) => r.positive - r.negative);

    md.push(
      "## Attribute framing (Levin & Gaeth 1988)",
      "",
      "Expected rating on a 0–4 scale (very poor … very good).",
      "",
      "| Item | Positive frame | Negative frame | Difference |",
      "| --- | --- | --- | --- |",
      ...rows2.map((r) => `| ${r.item} | ${f2(r.positive)} | ${f2(r.negative)} | ${signed(r.positive - r.negative, 2)} |`),
      "",
      `Mean difference ${signed(mean(d))} ${ci(bootstrapMean(d, 31))}; ${d.filter((x) => x > 0).length} of ${d.length} rated higher when framed positively.`,
      "",
    );
    json.attribute = { items: rows2, effect: { mean: mean(d), ci: bootstrapMean(d, 31) } };
  }

  // ---------- anchoring ----------
  {
    const items = [...new Set(jobs.filter((j) => j.study === "anchor").map((j) => j.item))];
    const vs = ["none", "irrelevant-low", "irrelevant-high", "comparative-low", "comparative-high"];
    const at = (item: string, v: string) => cells.get(`anchor:${item}:${v}`);
    const truth = (item: string) => jobs.find((j) => j.study === "anchor" && j.item === item)!.truth as number;
    const summary = vs.map((v) => {
      const xs = items.map((it) => ({ it, c: at(it, v) })).filter((x) => x.c);
      const ds = xs.map((x) => dist(x.c!.job.read, x.c!.answers));

      return {
        variant: v,
        n: xs.length,
        accuracy: mean(ds.map((p, i) => credit(p, String(truth(xs[i]!.it))))),
        pRight: mean(ds.map((p, i) => p[String(truth(xs[i]!.it))] ?? 0)),
        bias: mean(ds.map((p, i) => expected(p) - truth(xs[i]!.it))),
      };
    });
    const effect = (lo: string, hi: string) =>
      items
        .map((it) => {
          const a = at(it, lo);
          const b = at(it, hi);

          return a && b ? expected(dist(b.job.read, b.answers)) - expected(dist(a.job.read, a.answers)) : NaN;
        })
        .filter(Number.isFinite);
    const irr = effect("irrelevant-low", "irrelevant-high");
    const cmp = effect("comparative-low", "comparative-high");

    md.push(
      "## Anchoring (Tversky & Kahneman 1974; Strack & Mussweiler 1997)",
      "",
      "Six-level estimate bins; bias is the expected level minus the true level.",
      "",
      "| Anchor | n | Accuracy (top bin) | Mean P(true bin) | Mean bias (levels) |",
      "| --- | --- | --- | --- | --- |",
      ...summary.map((r) => `| ${r.variant} | ${r.n} | ${pct(r.accuracy)} | ${f2(r.pRight)} | ${signed(r.bias, 2)} |`),
      "",
      `High − low anchor, in levels: irrelevant number in the state ${signed(mean(irr))} ${ci(bootstrapMean(irr, 37))} (${irr.filter((x) => x > 0).length} of ${irr.length} towards the anchor); comparative question ${signed(mean(cmp))} ${ci(bootstrapMean(cmp, 41))} (${cmp.filter((x) => x > 0).length} of ${cmp.length}).`,
      "",
    );
    json.anchor = { summary, irrelevant: { mean: mean(irr), ci: bootstrapMean(irr, 37), values: irr }, comparative: { mean: mean(cmp), ci: bootstrapMean(cmp, 41), values: cmp } };
  }

  // ---------- decoy ----------
  {
    const items = [...new Set(jobs.filter((j) => j.study === "decoy").map((j) => j.item))];
    const share = (item: string, decoy: string, order: string) => {
      const c = cells.get(`decoy:${item}:${decoy}:${order}`);

      if (!c) return { a: NaN, d: NaN };

      const p = dist(c.job.read, c.answers);

      return { a: p.a! / (p.a! + p.b!), d: p.d ?? 0 };
    };
    const rows2 = items.map((it) => {
      const m = (decoy: string) => mean(["forward", "reversed"].map((o) => share(it, decoy, o).a));

      return {
        item: it,
        none: m("none"),
        decoyA: m("decoy-a"),
        decoyB: m("decoy-b"),
        effect: m("decoy-a") - m("decoy-b"),
        pDecoy: mean(["decoy-a", "decoy-b"].flatMap((dd) => ["forward", "reversed"].map((o) => share(it, dd, o).d))),
        order: mean(["none", "decoy-a", "decoy-b"].map((dd) => share(it, dd, "forward").a - share(it, dd, "reversed").a)),
      };
    }).filter((r) => Number.isFinite(r.effect));
    const e = rows2.map((r) => r.effect);
    const o = rows2.map((r) => r.order);

    md.push(
      "## Decoy / asymmetric dominance (Huber, Payne & Puto 1982)",
      "",
      "Share of A among A and B (decoy excluded), averaged over both orders.",
      "",
      "| Scenario | No decoy | Decoy worse than A | Decoy worse than B | A-decoy − B-decoy | P(decoy) | Forward − reversed order |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows2.map((r) => `| ${r.item} | ${f2(r.none)} | ${f2(r.decoyA)} | ${f2(r.decoyB)} | ${signed(r.effect, 2)} | ${f3(r.pDecoy)} | ${signed(r.order, 2)} |`),
      "",
      `Attraction effect (A-decoy − B-decoy): ${signed(mean(e))} ${ci(bootstrapMean(e, 43))}, ${e.filter((x) => x > 0).length} of ${e.length} in the human direction. Order (A's share when listed first − last): ${signed(mean(o))} ${ci(bootstrapMean(o, 47))}.`,
      "",
    );
    json.decoy = { scenarios: rows2, effect: { mean: mean(e), ci: bootstrapMean(e, 43) }, order: { mean: mean(o), ci: bootstrapMean(o, 47) } };
  }

  // ---------- likert ----------
  {
    const items = [...new Set(jobs.filter((j) => j.study === "likert").map((j) => j.item))];
    const a = (item: string, v: string) => {
      const c = cells.get(`likert:${item}:${v}`);

      if (!c) return NaN;

      return c.job.read.kind === "noul" ? Number(c.answers.q!.value) : expected(dist(c.job.read, c.answers));
    };
    const vs = ["agree-5", "agree-5-descending", "agree-3", "agree-7", "agree-5-endpoints", "agree-5-reversed-statement", "yes-no-agree", "yes-no-agree-reversed"];
    const rowsV = vs.map((v) => {
      const d = items.map((it) => a(it, v) - a(it, "agree-5")).filter(Number.isFinite);

      return { variant: v, n: d.length, agreement: mean(items.map((it) => a(it, v)).filter(Number.isFinite)), delta: mean(d), ci: bootstrapMean(d, 53), absDelta: mean(d.map(Math.abs)) };
    });
    const acqScore = items.map((it) => a(it, "agree-5") + a(it, "agree-5-reversed-statement") - 1).filter(Number.isFinite);
    const acqYes = items.map((it) => a(it, "yes-no-agree") + a(it, "yes-no-agree-reversed") - 1).filter(Number.isFinite);

    md.push(
      "## Likert scales (debatable opinions)",
      "",
      "Agreement on a 0–1 scale (expected level for scores, P(yes) for yes/no). Δ is against the 5-point ascending scale.",
      "",
      "| Variant | n | Mean agreement | Δ vs agree-5 [95% CI] | Mean |Δ| |",
      "| --- | --- | --- | --- | --- |",
      ...rowsV.map((r) => `| ${r.variant} | ${r.n} | ${f2(r.agreement)} | ${signed(r.delta)} ${ci(r.ci)} | ${f3(r.absDelta)} |`),
      "",
      `Acquiescence (agreement with a statement + with its reversal − 1; 0 means consistent): 5-point ${signed(mean(acqScore))} ${ci(bootstrapMean(acqScore, 59))}; yes/no ${signed(mean(acqYes))} ${ci(bootstrapMean(acqYes, 61))}.`,
      "",
      "| Statement | agree-5 | reversed | sum − 1 | yes/no | yes/no reversed | sum − 1 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...items.map((it) => `| ${it} | ${f2(a(it, "agree-5"))} | ${f2(a(it, "agree-5-reversed-statement"))} | ${signed(a(it, "agree-5") + a(it, "agree-5-reversed-statement") - 1, 2)} | ${f2(a(it, "yes-no-agree"))} | ${f2(a(it, "yes-no-agree-reversed"))} | ${signed(a(it, "yes-no-agree") + a(it, "yes-no-agree-reversed") - 1, 2)} |`),
      "",
    );
    json.likert = { variants: rowsV, acquiescence: { score: { mean: mean(acqScore), ci: bootstrapMean(acqScore, 59) }, yesNo: { mean: mean(acqYes), ci: bootstrapMean(acqYes, 61) } } };
  }

  return { md: md.join("\n"), json };
}

if (import.meta.main) {
  const dir = new URL(".", import.meta.url);
  const { md, json } = analyse(loadRows(dir));

  writeFileSync(new URL("./results.md", dir), `# Prose studies: results\n\nGenerated by \`analyze.ts\` from \`recordings/prose.jsonl(.gz)\`. Do not edit by hand.\n\n${md}\n`);
  writeFileSync(new URL("./results.json", dir), `${JSON.stringify(json, null, 1)}\n`);
  console.log(md);
}
