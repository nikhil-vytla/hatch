import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readRecord } from "../../experience-prototypes/scripts/records";
import { agentHarness, app, readApp } from "./routing.harness";
const doc = readRecord(new URL("../results/micro.jsonl", app));
const wirePath = new URL(`../runs/${doc.manifest.id}/requests.jsonl`, app);
const logs = readFileSync(wirePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
const successes = logs.filter(r => r.http_status === 200 && r.response?.answers);
const drinkWire = successes.find(r => r.tag === "beverage");
const drinkVerifier = successes.find(r => r.tag === "microagent/verify" && r.request.state.answer === "herbal_tea");
const expectedProperties = { temperature: "hot", caffeine: false, dairy: false, sweet: false };
const validDrinks = Object.entries(drinkWire.request.state.menu).filter(([, props]: any) => Object.entries(expectedProperties).every(([k, v]) => props[k] === v)).map(([id]) => id);
const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const h = agentHarness("micro", doc.result);
h.find("textarea").props.onChange({ target: { value: "Where is my invoice?" } }); h.render();
const pending = h.find("RunButton").props.onClick();
h.requests[0].resolve({ answers: { route: { value: "search" } } }); await tick();
if (h.requests.length !== 2) throw Error("Expected answer stage");
const beforeFinal = { storedGoal: h.inspector().goal, activeInput: h.find("textarea").props.value, requestCount: h.requests.length };
h.find("select").props.onChange({ target: { value: "1" } }); h.render();
h.requests[1].resolve({ answers: { answer: { value: "billing" } } }); await tick();
if (h.requests.length !== 3) throw Error("Expected verification stage");
h.requests[2].resolve({ answers: { supported: { value: 0.98 }, complete: { value: 0.96 } } }); await pending; h.render();
const final = { activeInput: h.find("textarea").props.value, selectedIndex: h.find("select").props.value, result: h.inspector(), visibleCards: h.all().filter(n => n.type === "motion.div").map(n => h.text(n)) };
const ask = agentHarness("micro", doc.result);
ask.find("textarea").props.onChange({ target: { value: "Change my actual account password" } }); ask.render();
const askRun = ask.find("RunButton").props.onClick();
ask.requests[0].resolve({ answers: { route: { value: "ask" } } }); await askRun; ask.render();
const failed = agentHarness("micro", doc.result);
failed.find("textarea").props.onChange({ target: { value: "Where is my invoice?" } }); failed.render();
const failedRun = failed.find("RunButton").props.onClick();
failed.requests[0].resolve({ answers: { route: { value: "search" } } }); await tick();
failed.requests[1].resolve({ answers: { answer: { value: "billing" } } }); await tick();
failed.requests[2].reject(new Error("Synthetic verifier transport failure"));
let error = ""; try { await failedRun; } catch (e) { error = String(e); }
failed.render();
const out = {
  method: "Decoded three published rows and all recorded wire attempts; executed actual micro-agent callbacks through the offline harness, loading the real static document and drink catalogs. Synthetic stage responses/failures test software flow only. No browser or model/API calls.",
  hashes: { component: createHash("sha256").update(readApp("src/agent-experiments.tsx")).digest("hex"), record: createHash("sha256").update(readFileSync(new URL("../results/micro.jsonl", app))).digest("hex"), wire: createHash("sha256").update(readFileSync(wirePath)).digest("hex") },
  coverage: { planned: doc.result.rows.length, completed: doc.result.rows.filter((r: any) => !r.error).length, unavailable: doc.result.rows.filter((r: any) => r.error).length, availableRoutes: doc.result.rows.filter((r: any) => !r.error).map((r: any) => r.route), searchCompleted: doc.result.rows.filter((r: any) => r.route === "find_policy").length, successfulCalls: successes.length, successfulPrimitiveAnswers: successes.reduce((n: number, r: any) => n + Object.keys(r.response.answers).length, 0), attemptsByStage: Object.fromEntries([...new Set(logs.map(r => r.tag))].map(tag => [tag, logs.filter(r => r.tag === tag).map(r => r.http_status)])), transport: doc.result.transport },
  independentDrinkCheck: { declaredFixtureRequirements: expectedProperties, validDrinks, selected: doc.result.rows.find((r: any) => r.route === "choose_drink").answer, note: "Deterministic check of this one explicit recorded request against the original supplied menu, not general natural-language parsing accuracy." },
  recordedChecker: { request: drinkVerifier.request, rawAnswer: drinkVerifier.response.answers, receivesMenu: Object.hasOwn(drinkVerifier.request.state, "menu") || Object.hasOwn(drinkVerifier.request.state.tool_result, "menu"), receivesPriorModelProbabilities: !!drinkVerifier.request.state.tool_result.probabilities, routeAnswersRetained: doc.result.rows.filter((r: any) => r.routing?.answers).length },
  liveSearch: { requests: h.requests, beforeFinal, final, resolvedPassage: h.docs.find((d: any) => d.id === final.result.answer)?.text, finalRowContainsCorpusSnapshot: Object.hasOwn(final.result, "evidence") || Object.hasOwn(final.result, "state"), note: "Live answer and verifier receive the document ID billing, not the resolved passage; final UI cards show the ID. Full evidence was provided to the verifier but not preserved in the final row." },
  unsupportedVsClarification: { recordedUnsupported: doc.result.rows.find((r: any) => r.route === "unsupported"), liveAsk: ask.inspector(), liveCallCount: ask.requests.length, inputControlCount: ask.all().filter(n => n.type === "textarea" || n.type === "input").length, note: "Ask supplies no concrete follow-up question or accumulated dialogue; it terminates after routing." },
  lostPartialStage: { error, completedStages: failed.requests.slice(0, 2).map(r => Object.keys(r.questions)), afterFailureRow: failed.inspector(), note: "Shared useRun normally catches and displays this error; mock harness propagates it so the probe can inspect unchanged component state. Successful route/tool stages are not checkpointed in row state." },
};
if (validDrinks.join() !== "herbal_tea" || out.recordedChecker.receivesMenu || final.result.answer !== "billing" || final.selectedIndex !== 1 || ask.requests.length !== 1) throw Error("Micro audit assumptions changed");
writeFileSync(new URL("micro.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ planned: 3, completed: 2, searchCompleted: 0, successfulCalls: successes.length, primitiveAnswers: out.coverage.successfulPrimitiveAnswers, drinkOracle: validDrinks, checkerMenu: out.recordedChecker.receivesMenu, liveAnswer: final.result.answer, askCalls: ask.requests.length, partialStagesLost: 2 }));
