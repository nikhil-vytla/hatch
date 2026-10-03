#!/usr/bin/env bun
/**
 * jev-lab, a CLI for the Jev experiments' studies.
 *
 *   jev-lab eval <fool|suggestion|decoy> --endpoint <jev|systemone:URL|decisions:URL> [--out file.jsonl]
 *           [--dry-run] [--max-usd 0.05] [--resume] [--limit N] [--model NAME] [--usd-per-mtok X]
 *   jev-lab report <recording.jsonl[.gz]> [--study S]
 *   jev-lab compare <a.jsonl[.gz]> <b.jsonl[.gz]>
 *   jev-lab bouncer <agent-log.json> [--endpoint ...] [--json]
 *   jev-lab serve-mock [--port 31337]
 *   jev-lab studies
 */
import { readFileSync } from "node:fs";
import { decoy, fool, suggestion } from "./src/analysis";
import { check, judge, parseLog } from "./src/bouncer";
import { compare } from "./src/compare";
import { endpoint } from "./src/endpoints";
import { serveMock } from "./src/mock";
import { readRows, receiptLine, run, type Row } from "./src/record";
import { isStudy, jobsFor, STUDIES, studyOf, type StudyId } from "./src/studies";
import { f2, f3, interval, signed, table } from "./src/table";

const argv = process.argv.slice(2);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && !["--dry-run", "--resume", "--json"].includes(argv[i - 1]!)));
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);

  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const die = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

export function report(study: StudyId, rows: Row[]) {
  if (study === "suggestion")
    return table(
      ["suggestion (20 true/false claims)", "n", "flips", "P(right)", "Δ vs canonical [95% CI]"],
      suggestion(rows).map((r) => [r.variant, r.n, r.flips, f2(r.pRight), `${signed(r.delta)} ${interval(r.deltaCI)}`]),
    );

  if (study === "decoy") {
    const d = decoy(rows);

    return [
      table(
        ["decoy scenario", "no decoy", "worse A", "worse B", "effect"],
        d.scenarios.map((s) => [s.item, f2(s.none), f2(s.decoyA), f2(s.decoyB), signed(s.effect, 2)]),
      ),
      `attraction effect ${signed(d.effect.mean)} ${interval(d.effect.ci)}, ${d.humanDirection} of ${d.scenarios.length} scenarios in the human direction`,
    ].join("\n\n");
  }

  return table(
    ["sentence added to the question", "flipped", "ruled out", "mean P(right)"],
    fool(rows).map((r) => [r.sentence, `${r.flipped} of ${r.puzzles}`, r.ruledOut, f3(r.meanRight)]),
  );
}

async function main() {
  const [cmd, ...rest] = positional;

  if (cmd === "studies") {
    for (const s of STUDIES) console.log(`${s.padEnd(11)} ${jobsFor(s).length} requests`);
    return;
  }

  if (cmd === "eval") {
    const study = rest[0] ?? die(`Which study? ${STUDIES.join(", ")}`);

    if (!isStudy(study)) die(`Unknown study "${study}". Try: ${STUDIES.join(", ")}`);

    const spec = flag("endpoint") ?? die("Pass --endpoint jev | systemone:http://host:port | decisions:http://host:port");
    const ep = endpoint(spec, { model: flag("model"), usdPerMTok: flag("usd-per-mtok") ? Number(flag("usd-per-mtok")) : undefined });
    const out = flag("out") ?? `${study}.${spec.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "")}.jsonl`;
    const result = await run(jobsFor(study as StudyId), ep, {
      out,
      dryRun: has("dry-run"),
      resume: has("resume"),
      maxUsd: flag("max-usd") ? Number(flag("max-usd")) : undefined,
      limit: flag("limit") ? Number(flag("limit")) : undefined,
    });

    if (has("dry-run")) return;

    console.log(`${study} on ${ep.label}: sent ${result.sent}, ${result.ok} ok, ${result.errors} errors, ${result.skipped} already recorded, $${result.spentUsd.toFixed(6)} this run.`);

    if (result.stopped) console.log(`stopped: ${result.stopped}`);

    const rows = readRows(out);

    console.log(`receipt: ${receiptLine(rows)}`);
    console.log(`recording: ${out}\n`);
    console.log(report(study as StudyId, rows));
    return;
  }

  if (cmd === "report") {
    const rows = readRows(rest[0] ?? die("Which recording?"));
    const studies = flag("study") ? [flag("study") as StudyId] : [...new Set(rows.map((r) => studyOf(r.id)).filter((s): s is StudyId => s !== null))];

    console.log(`receipt: ${receiptLine(rows)}\n`);

    for (const s of studies) console.log(`${report(s, rows)}\n`);
    return;
  }

  if (cmd === "compare") {
    const [a, b] = rest;

    if (!a || !b) die("Usage: jev-lab compare a.jsonl b.jsonl");

    const c = compare(readRows(a!), readRows(b!));

    console.log(`studies in both: ${c.studies.join(", ") || "none"}`);
    console.log(`top-answer agreement: ${c.agreement.agree} of ${c.agreement.shared} shared questions (${f3(c.agreement.rate)})\n`);

    for (const s of c.perStudy) {
      if ("difference" in s && s.difference)
        console.log(`decoy effect: A ${signed(s.a.mean)} ${interval(s.a.ci)} · B ${signed(s.b.mean)} ${interval(s.b.ci)} · A − B ${signed(s.difference.mean)} ${interval(s.difference.ci)} over ${s.difference.scenarios} scenarios`);
      else if (s.a && s.b && "flipped" in s.a && "flipped" in s.b)
        console.log(`${s.study} flips: A ${s.a.flipped} of ${s.a.n} · B ${s.b.flipped} of ${s.b.n}`);
    }

    console.log(`\nA: ${c.receipts.a.ok} ok · ${c.receipts.a.inputTokens.toLocaleString("en")} tokens · $${c.receipts.a.costUsd.toFixed(6)} · p50 ${c.receipts.a.latencyMs.p50} ms`);
    console.log(`B: ${c.receipts.b.ok} ok · ${c.receipts.b.inputTokens.toLocaleString("en")} tokens · $${c.receipts.b.costUsd.toFixed(6)} · p50 ${c.receipts.b.latencyMs.p50} ms`);
    return;
  }

  if (cmd === "bouncer") {
    const log = parseLog(JSON.parse(readFileSync(rest[0] ?? die("Which agent log?"), "utf8")));
    const findings = check(log);

    if (flag("endpoint")) await judge(log, findings, endpoint(flag("endpoint")!, { model: flag("model") }));

    if (has("json")) console.log(JSON.stringify(findings, null, 2));
    else {
      console.log(`${log.calls.length} tool calls, ${findings.filter((f) => f.severity === "error").length} errors, ${findings.filter((f) => f.severity === "warn").length} warnings\n`);
      console.log(
        table(
          ["call", "tool", "argument", "value", "finding", "P(grounded)"],
          findings.map((f) => [`#${f.call + 1}`, f.tool, f.argument || "—", f.value.length > 28 ? `${f.value.slice(0, 27)}…` : f.value || "—", `${f.severity}: ${f.kind}`, f.pGrounded === undefined ? "—" : f2(f.pGrounded)]),
        ),
      );
    }

    process.exitCode = findings.some((f) => f.severity === "error") ? 1 : 0;
    return;
  }

  if (cmd === "serve-mock") {
    const s = serveMock({ port: Number(flag("port") ?? 31337) });

    console.log(`mock /v1/systemone on http://localhost:${s.port} (hash answers, not a model). Ctrl-C to stop.`);
    return;
  }

  console.log(readFileSync(new URL("./README.md", import.meta.url), "utf8").split("\n## ")[0]);
}

if (import.meta.main) await main();
