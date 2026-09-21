import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readRecord } from "../../experience-prototypes/scripts/records";
import { agentHarness, app, readApp } from "./routing.harness";
const doc = readRecord(new URL("../results/search.jsonl", app));
const rows = doc.result.rows;
const wirePath = new URL(`../runs/${doc.manifest.id}/requests.jsonl`, app);
const logs = readFileSync(wirePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
const successful = logs.filter(r => r.http_status === 200 && r.response?.answers);
const h = agentHarness("search", doc.result);
const documents = successful[0].request.state.documents;
const cards = (view: ReturnType<typeof agentHarness>) => view.all().filter(n => n.type === "motion.article").map(n => ({ id: n.props.key, kept: n.props.className.includes("kept"), text: view.text(n) }));
const renderedRows = rows.map((row: any) => { const view = agentHarness("search", { rows: [row] }); return { query: row.query, recordedKept: row.kept.map((d: any) => d.id), displayedKept: cards(view).filter(c => c.kept).map(c => c.id), recordedBestProbability: row.answers.best.probabilities[row.best], barsRendered: !!view.find("Bars") }; });
const pending = h.find("RunButton").props.onClick();
h.find("select").props.onChange({ target: { value: "1" } }); h.render();
const before = { query: h.find("textarea").props.value, rowQuery: h.inspector().query, index: h.find("select").props.value };
h.requests[0].resolve({ answers: rows[0].answers, source: "synthetic-delayed-success" }); await pending; h.render();
const after = { query: h.find("textarea").props.value, resultText: h.inspector().text, best: h.inspector().best, index: h.find("select").props.value };
const injected = structuredClone(rows[0]);
injected.answers.relevant_injection.value = 0.95;
injected.answers.injection_injection.value = 0.99;
const injectedView = agentHarness("search", { rows: [injected] });
const componentKept = cards(injectedView).filter(c => c.kept).map(c => c.id);
const runnerKept = documents.filter((d: any) => d.critical || (injected.answers[`relevant_${d.id}`].value >= 0.5 && injected.answers[`injection_${d.id}`].value < 0.5)).map((d: any) => d.id);
if (!componentKept.includes("injection") || runnerKept.includes("injection")) throw Error("Filtering mismatch reproduction changed");
const missing = agentHarness("search", { rows: [{ query: rows[0].query, best: "refund", prediction: "refund", answers: { best: rows[0].answers.best } }] });
const output = {
  method: "Inspected all five published records and successful wire bodies, compared current component corpus, executed actual search callbacks and rendered synthetic boundary records. No browser, corpus download, model/API calls or app edits.",
  hashes: { record: createHash("sha256").update(readFileSync(new URL("../results/search.jsonl", app))).digest("hex"), component: createHash("sha256").update(readApp("src/agent-experiments.tsx")).digest("hex"), wire: createHash("sha256").update(readFileSync(wirePath)).digest("hex") },
  evidence: { queries: rows.length, uniqueQueries: new Set(rows.map((r: any) => r.query)).size, corpusDocuments: documents.length, corpusCharacters: documents.reduce((n: number, d: any) => n + d.text.length, 0), primitiveAnswers: rows.reduce((n: number, r: any) => n + Object.keys(r.answers).length, 0), exactBestCorrect: rows.filter((r: any) => r.best === r.target).length, answerableQueries: rows.filter((r: any) => r.target !== "none").length, noAnswerQueries: rows.filter((r: any) => r.target === "none").length, goldEvidenceRetainedIncludingVacuousNone: rows.filter((r: any) => r.gold_evidence_retained).length, answerableGoldRetained: rows.filter((r: any) => r.target !== "none" && r.kept.some((d: any) => d.id === r.target)).length, injectionExcluded: rows.filter((r: any) => r.injection_excluded).length, renderedRows, transport: doc.result.transport },
  corpus: { currentUIEqualsRecorded: JSON.stringify(documents) === JSON.stringify(h.docs), allDocumentsStoredInEachPublishedRow: rows.every((r: any) => Array.isArray(r.documents) || Array.isArray(r.state?.documents)), retainedDocumentsOnly: true, attackMetadata: documents.find((d: any) => d.id === "injection") },
  protocol: { recordedQuestionCount: Object.keys(successful[0].request.questions).length, liveQuestionCount: Object.keys(h.requests[0].questions).length, recordedQuestions: successful[0].request.questions, liveQuestions: h.requests[0].questions, rawTargetsInState: successful.some(r => Object.hasOwn(r.request.state, "target")) },
  syntheticRelevantInjection: { relevance: 0.95, injection: 0.99, runnerKept, componentKept, note: "Counterexample to implementation parity; not a measured model failure or security boundary claim." },
  syntheticMissingScores: { cards: cards(missing), note: "The current five records have all relevance scores. The fallback manufactures winner=1 and other=0 and labels them relevance judgments." },
  staleQuery: { before, after, note: "The result preserves the old query text but replaces the selected example despite a newer editor/dropdown state." },
};
if (!output.corpus.currentUIEqualsRecorded || output.evidence.primitiveAnswers !== 65 || output.protocol.liveQuestionCount !== 7 || after.best !== "refund" || after.index !== 1) throw Error("Recorded/probe expectations changed");
writeFileSync(new URL("search.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ queries: 5, documents: 6, recordedDecisions: 65, liveDecisionsPerQuery: 7, currentCorpusMatches: true, syntheticRetainedAttack: componentKept.includes("injection"), recordedProbabilityBars: renderedRows.filter(r => r.barsRendered).length, staleBest: after.best }));
