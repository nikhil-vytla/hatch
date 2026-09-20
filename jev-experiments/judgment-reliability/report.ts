import { writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./analyze";
const here = dirname(fileURLToPath(import.meta.url)), { result: r } = summarize();
const pct = (x: number | null) => x == null ? "unavailable" : `${(x * 100).toFixed(2)}%`;
const pilot = readFileSync(resolve(here, "pilot/events.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
const p = r.metrics.primary.pairwise, done = r.availability.completed === r.availability.planned;
const text = `# Judgment reliability on complete JudgeBench

${done ? "Completed" : "Recording in progress"}: ${r.availability.completed.toLocaleString()}/${r.availability.planned.toLocaleString()} evaluation records, covering ${r.availability.completed_decisions.toLocaleString()}/${r.availability.planned_decisions.toLocaleString()} independent question decisions. The frozen study includes all 620 released response pairs, both orders, three unchanged pairwise passes, pair-context whole-answer scoring, and isolated-candidate whole-answer scoring. ${done ? `Pass 1 official two-order accuracy is ${pct(p.official_accuracy)}, compared with ${pct(p.ordered_accuracy)} single-order accuracy and ${pct(p.position_flip_rate)} swap-induced answer-identity flips.` : "All scores below are provisional until coverage is complete. Missing evaluations are retained in planned denominators and availability is shown separately."}

## Design and source

[JudgeBench](https://github.com/ScalerLab/JudgeBench/tree/${r.manifest.source_commit}) supplies 350 GPT-4o pairs and 270 Claude 3.5 Sonnet pairs. These are 620 candidate pairs from 268 source-question clusters, with 308 MMLU-Pro, 239 LiveBench and 73 LiveCodeBench pairs. The source commit is pinned to \`${r.manifest.source_commit}\`; manifest.json stores source-file SHA-256 values, complete input hash, protocol hash and maximum input size. cases.jsonl contains the full original question and both answers plus provenance and content triage. No candidate generation or model training occurred.

The frozen v2 encoding follows the [TypeSafe independent-question contract](https://docs.typesafe.ai/primitives). Each question contains its exact complete evidence. Pairwise and shared pointwise questions each see the entire pair; isolated pointwise questions see one candidate as answer A. All questions share only a constant policy state. The provider contract says questions are evaluated independently, so another question's opponent text is not part of the isolated question's information set. This is a documented API assumption, not an empirically proven absence of provider cross-question interference.

Both orientations use the same pairwise instructions and whole-answer correctness questions. Repeats keep per-question content and hashes unchanged. Three sequential passes use scheduling seeds 42, 43 and 44; these seeds do not control sampling inside the model. Within each pass, cases and methods are interleaved. Native batches are limited to 24 questions and 64,000 serialized bytes. There is no concatenation of unrelated evidence inside one question and no gold leakage. Batch mappings, original question hashes, whole request hashes, timestamps, returned model identifiers and attempts remain in the append-only events.jsonl.

The original state-encoded pilot recorded ${pilot.filter(e => e.status === "completed").length} successful evaluation records before shared-key rate limits made separate HTTP requests wasteful. It lives in pilot/ and is excluded from every v2 aggregate. The v2 encoding changes context placement, so these results cannot be pooled with that pilot or the historical 100-pair gallery.

## Results

| Pass | Pairwise official | Pair-context pointwise official | Pairwise ordered | Isolated accuracy | Complete paired orders |
| --- | ---: | ---: | ---: | ---: | ---: |
${r.metrics.per_repeat.map(x => `| ${x.repeat + 1} | ${pct(x.pairwise.official_accuracy)} | ${pct(x.shared.official_accuracy)} | ${pct(x.pairwise.ordered_accuracy)} | ${pct(x.isolated.accuracy)} | ${x.pairwise.completed_pairs}/620 |`).join("\n")}

The [official scorer](https://github.com/ScalerLab/JudgeBench/blob/${r.manifest.source_commit}/utils/metrics.py) reverses the second displayed vote, adds +1 for a correct vote, -1 for an incorrect vote and 0 for a tie or null, and credits a positive sum. With two completed A/B votes this requires the correct answer in both orders. Nulls retain official behavior, so a correct vote plus a null can receive official credit; availability remains explicit. Pair-context pointwise ties remain exact ties instead of becoming answer A. Isolated scoring ranks two separate scores and has no genuine two-order score.

| Source response model | Pairs | Mean official pairwise over 3 passes | Mean official pair-context | Mean isolated accuracy |
| --- | ---: | ---: | ---: | ---: |
${r.metrics.by_response_model.map(x => `| ${x.model} | ${x.pairs} | ${pct(x.pairwise.official_accuracy)} | ${pct(x.shared.official_accuracy)} | ${pct(x.isolated.accuracy)} |`).join("\n")}

| Method | Complete 3-pass sets | Answer identity flips | Tie transitions | Nonzero score drift | Mean score range |
| --- | ---: | ---: | ---: | ---: | ---: |
${Object.entries(r.metrics.stability).map(([name, v]: [string, any]) => `| ${name} | ${v.complete_sets}/${v.planned_sets} | ${v.identity_flips} | ${v.tie_transitions} | ${v.nonzero_score_drift} | ${v.mean_score_range?.toFixed(5) ?? "unavailable"} |`).join("\n")}

Answer flips require both A and B to win within a matched set. A winner/tie transition is separate. Numerical drift is the range of canonical P(A) for pairwise judgments, or the larger of the two candidate score ranges for pointwise judgments. A score can move while the best answer stays fixed. The 1,240 pair-orientation repeat sets are not independent source questions.

## Paired uncertainty

Intervals use 10,000 reproducible bootstrap draws over source plus original_id clusters, preserving candidate pairs, both response models, orientations and repeats within each source question. They estimate variation across broader questions, not uncertainty in the fixed benchmark count. Comparisons use the same original cases. Missing matched sets are excluded from intervals and their counts are explicit.

| Quantity | Matched pairs | Clusters | Estimate | 95% interval |
| --- | ---: | ---: | ---: | --- |
${r.metrics.confidence_intervals.map(x => `| ${x.name} | ${x.cases} | ${x.clusters} | ${pct(x.estimate)} | ${pct(x.low)} to ${pct(x.high)} |`).join("\n")}

Analytic controls include fixed displayed-A voting, which earns 50% ordered accuracy and 0% official two-order accuracy; independently random votes, with 25% expected official accuracy; and one random canonical answer held constant across swaps, with 50% expected official accuracy. Shorter/longer original-text baselines are evaluated deterministically, with equal lengths represented as ties. These controls explain why the two accuracy measures differ without changing the official metric.

## Availability and limitations

${r.availability.completed_batches} native batches returned ${r.availability.completed_decisions.toLocaleString()} question decisions across ${r.availability.attempts} network attempts. ${r.availability.unsuccessful_attempts} attempts were unsuccessful, ${r.availability.transient_failed_invocations} logical batch invocations exhausted transient retries, and ${r.availability.blocked_invocations} nontransient failures were retained. Median successful-batch latency was ${r.availability.median_latency_ms ?? "unavailable"}ms and the 95th percentile ${r.availability.p95_latency_ms ?? "unavailable"}ms, including internal retries. The observed window is ${r.availability.first_at ?? "unavailable"} to ${r.availability.last_at ?? "unavailable"}. Returned model aliases: ${r.availability.returned_models.join(", ") || "none"}. The provider did not expose a separate immutable model revision. Reported cost is ${r.availability.reported_cost_usd == null ? "unavailable" : `$${r.availability.reported_cost_usd}`}; a zero metadata value is not a billing audit.

Repeated observations share one collection window and do not establish long-term provider stability. The benchmark is public, so training-data contamination is not ruled out. Model confidence and correctness scores are not calibrated truth probabilities. Whole-answer scoring is not claim-level verification. No labels or response models were sent in evidence; the upstream objective label supplies the scoring target. We retained incorrect judgments and exact returned numbers. Only transport/transient failures can be retried. Completed judgments cannot be replaced by more favorable answers.

## Explorer and content handling

The replacement JudgeBench component navigates unique pairs, preserves answer identities across swaps, saves the first blind practice vote on the device, and requires a separate reveal for labels. Diagnostic filters preserve entire pairs across methods and repeats. The matrix distinguishes canonical winner flips, pointwise ties and score drift. It shows full raw question/answer text, expanded reading, source links, exact hashes, exports, split metrics, score distributions and separate provider availability. Per-pair chunks load independently of the complete evidence archive.

Content triage reuses 10 exact-question matches to prior human review and adds 11 lexically flagged pairs. Those 21 pairs require a deliberate text reveal. The lexical scan is not an exhaustive human audit. Original strings render as React text, including HTML syntax, and no raw HTML executes. The source and evidence archives require an explicit download click.

## Reproduction

Run from the repository root, using Bun and the existing local recording credential loader. Credentials remain server-side and are never imported into the frontend.

\`\`\`sh
bun jev-experiments/judgment-reliability/prepare-source.ts
bun jev-experiments/judgment-reliability/record.ts
bun test jev-experiments/judgment-reliability/scoring.test.ts
bun jev-experiments/judgment-reliability/verify.ts --complete
bun jev-experiments/judgment-reliability/analyze.ts
bun jev-experiments/judgment-reliability/prepare.ts /tmp/judge-preview
bun jev-experiments/judgment-reliability/report.ts
\`\`\`

prepare-source.ts uses the pinned upstream files in the existing ignored cache and refuses source/protocol drift. A clean checkout already contains cases.jsonl and manifest.json, so recording and analysis can start without that preparation step. record.ts resumes only unanswered evaluations, verifies successful question hashes, logs retries and recovers normalized rows from complete recorded batches if interrupted. Set JUDGE_CONCURRENCY only to change recording pace. prepare.ts exposes prepareJudgmentReliability(target) for the app's clean build; it generates hashed chunks from committed evidence and returns the compact publication document.

Seven deterministic tests cover the full official vote/tie/null truth table, identity remapping, ties versus numeric drift, all source coverage, exact candidate preservation, no gold metadata in model evidence, content gate retention, and unchanged per-question hashes/information sets across all three repeats. Browser validation is recorded in NOTES.md.

For an already-running recording, \`bun jev-experiments/judgment-reliability/finalize.ts --wait-for-pid=PID\` waits for that process, requires its lock to be gone, then runs complete verification, analysis and report generation. It makes no model calls, commits or deployments. An ignored \`.finalization.json\` records completion or a failure requiring review. Publish a final data snapshot only after inspecting the verified reports.
`;
writeFileSync(resolve(here, "README.md"), text);
writeFileSync(resolve(here, "_summary.md"), `The judgment reliability experiment measures position bias, repeatability, and whole-answer scoring on all 620 [JudgeBench](https://github.com/ScalerLab/JudgeBench) pairs from 268 original source questions. Three unchanged passes compare pairwise choice, shared-context correctness scoring, and isolated-candidate scoring through [TypeSafe independent questions](https://docs.typesafe.ai/primitives), with ${r.availability.completed_decisions.toLocaleString()}/${r.availability.planned_decisions.toLocaleString()} decisions recorded so far. ${done ? `The first-pass official two-order score is ${pct(p.official_accuracy)}, while ordered accuracy is ${pct(p.ordered_accuracy)} and ${pct(p.position_flip_rate)} of paired winners flip after a swap.` : "Recording remains incomplete and displayed aggregate scores are provisional."} The explorer preserves full source text, explicit sensitive-content gates, first blind votes, immutable evidence, paired uncertainty, and separate provider-availability metrics.\n`);
console.log(JSON.stringify({ report: "README.md", complete: done, decisions: r.availability.completed_decisions }));
