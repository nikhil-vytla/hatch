import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { initial, recordedRequest as arcadeRequest } from "../../local-models-and-games/arcade/engine";
import { answerRequest, PUZZLES, refereeRequest, sentencesFor } from "../../packages/arena/src/fool/model";
import { allJobs } from "../../packages/arena/prose/variants";
import { allProfiles, jevRequest as rumourRequest } from "../../live-worlds/rumour/profiles";
import { createReef, view } from "../../live-worlds/ocean/engine";
import { jevRequest as reefRequest } from "../../live-worlds/ocean/models";
import { editQuestions, editState, INITIAL_OUTFIT } from "../../wardrobe-lab/engine";
import { encodedQuestions, POLICY_STATE, type Pair, type Task } from "../../judgment-reliability/wire";
import { payload as rewardPayload } from "../../rewardbench2/wire";
import { STUDIES } from "../../tools/decide-cli/src/studies";
import { readRecord } from "../scripts/records";
import {
  cliSnippet,
  collectRequests,
  curlBodies,
  curlSnippet,
  gatewayBody,
  GATEWAY_BASE_URL,
  GATEWAY_MODEL,
  MAX_SHOWN,
  pythonSnippet,
  typescriptSnippet,
  type NamedRequest,
} from "./build-this-snippets";
import { intentRequest, robustnessRequest } from "./intent-requests";
import { recordedRequests } from "./new-experiments";
import { TetrisArena } from "../../packages/arena/src/tetris";
import { framedJev, type FramingId, type Wire } from "../../packages/arena/src/tetris-framings";
import { firstCompositionRequest } from "./composition-request";

/** The first request an arena Tetris lane sends with a framing, captured from the arena itself. */
async function tetrisRequest(framing: FramingId) {
  let body: Wire | undefined;
  const lane = framedJev(framing, async (b) => {
    body ??= b;
    throw new Error("captured");
  });

  await new TetrisArena(7, [lane], "turns", { pieceLimit: 40 }).turn();

  return body;
}

const reef = createReef(7);
const pair: Pair = {
  pair_id: "p1",
  original_id: 1,
  source: "mmlu",
  response_model: "m",
  question: "Is 2 + 2 = 4?",
  response_A: "Yes.",
  response_B: "No, it's 5 — \"obviously\".",
  label: "A>B",
};

/** The scenes' own request builders, plus a request built to stress escaping. */
const CASES: Record<string, unknown> = {
  "Fool Jev, answer and referee": { answer: answerRequest(PUZZLES[0], sentencesFor(PUZZLES[0].id)[1]), referee: refereeRequest(PUZZLES[0], sentencesFor(PUZZLES[0].id)[1]) },
  "prose study": allJobs().find((j) => j.family === "suggestion")?.request,
  "rumour mill": rumourRequest(allProfiles("rumour").slice(0, 3), "rumour", "Free cake at the bakery!", null, "bakery"),
  "the reef": reefRequest(reef.fish.slice(0, 3).map((f) => view(reef, f))),
  "intent benchmark": intentRequest("clinc150", "what's the weather like"),
  "robustness, quoted injection": robustnessRequest({ variant: "quoted_injection", original_text: "Where is my card?" }),
  "arcade move": arcadeRequest(initial("snake", 7)),
  wardrobe: { state: editState(INITIAL_OUTFIT, "make the jacket navy"), questions: editQuestions(INITIAL_OUTFIT) },
  "change impact": recordedRequests.changes(),
  "arena Tetris, judge each spot": await tetrisRequest("spot-clean-confident"),
  "arena Tetris, pick one landing": await tetrisRequest("landing-choice"),
  "Generated UI, first decision": await firstCompositionRequest({ domain: "apartments", prompt: "Compare all three apartments. Show rent, commute, budget, and a shortlist button for each." }),
  "judgment reliability": { state: POLICY_STATE, questions: encodedQuestions(pair, { id: "p1/r0/shared/AB", pair_id: "p1", repeat: 0, condition: "shared", swap: false }) },
  rewardbench: rewardPayload({ id: "1", subset: "Ties", prompt: "Say hi", candidates: [{ label: "A", text: "hi", model: "m", chosen: true }], num_correct: 1, num_incorrect: 0, input_hash: "" }),
  escapes: {
    state: { text: "naïve “quotes” \\ back\nslash\ttab   😀 '''", n: 1.5e-7, big: 12345678901234, t: true, f: false, z: null, empty: [], none: {} },
    questions: { q: { type: "score", instructions: "Rate 'it' \"now\"", criteria: ["1", "2"] }, c: { type: "choice", instructions: null, criteria: { a: "A" } } },
  },
  "a batched run": [1, 2, 3].map((i) => ({ state: { i }, questions: { [`q${i}`]: { type: "noul", instructions: `Is ${i} odd?` } } })),
};

const roundTrip = (x: unknown) => JSON.parse(JSON.stringify(x));
const shown = (rs: NamedRequest[]) => rs.slice(0, MAX_SHOWN).map((r) => roundTrip(r.request));

describe("Build this snippets", () => {
  for (const [name, value] of Object.entries(CASES)) {
    const requests = collectRequests(value);

    test(`${name}: finds the request`, () => {
      expect(requests.length).toBeGreaterThan(0);
    });

    test(`${name}: the curl bodies are valid JSON and are the server's exact body`, () => {
      const bodies = curlBodies(curlSnippet(requests));

      expect(bodies.length).toBe(Math.min(requests.length, MAX_SHOWN));
      bodies.forEach((b, i) => expect(JSON.parse(b)).toEqual(roundTrip(gatewayBody(requests[i].request))));
    });

    test(`${name}: the TypeScript compiles and sends exactly this request`, async () => {
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(typescriptSnippet(requests));
      const calls: unknown[] = [];
      const clients: unknown[] = [];
      class TypeSafeClient {
        constructor(options: unknown) {
          clients.push(options);
        }
        async systemOne(request: unknown) {
          calls.push(request);
          return { answers: new Proxy({}, { get: () => ({ choice: "a", noul: 0.5, score: 0.5 }) }) };
        }
      }
      const body = js.replace(/^import \{ TypeSafeClient \} from "@typesafe-ai\/sdk";$/m, "");
      const run = new Function("TypeSafeClient", "process", "console", `return (async () => {\n${body}\n})();`);

      await run(TypeSafeClient, { env: { AI_GATEWAY_API_KEY: "from-env" } }, { log() {} });
      expect(clients).toEqual([{ apiKey: "from-env", baseURL: GATEWAY_BASE_URL, defaultModel: GATEWAY_MODEL }]);
      expect(roundTrip(calls)).toEqual(shown(requests));
    });

    test.skipIf(!Bun.which("python3"))(`${name}: the Python runs and sends exactly this request`, () => {
      const dir = mkdtempSync(join(tmpdir(), "build-this-"));
      mkdirSync(join(dir, "typesafe_sdk"));
      // A stand-in for typesafe-sdk that records each call instead of sending it.
      writeFileSync(
        join(dir, "typesafe_sdk", "__init__.py"),
        [
          "import atexit, json, types",
          "CALLS, CLIENTS = [], []",
          "atexit.register(lambda: print(json.dumps({'calls': CALLS, 'clients': CLIENTS})))",
          "class _Any(dict):",
          "    def __missing__(self, key): return types.SimpleNamespace(noul=0.5, choice='a', score=0.5)",
          "class TypeSafeClient:",
          "    def __init__(self, **kw): CLIENTS.append(kw)",
          "    def __enter__(self): return self",
          "    def __exit__(self, *a): return False",
          "    def system_one(self, state, questions, **kw):",
          "        CALLS.append({'state': state, 'questions': questions})",
          "        return types.SimpleNamespace(nouls=_Any(), choices=_Any(), scores=_Any())",
        ].join("\n"),
      );
      writeFileSync(join(dir, "snippet.py"), pythonSnippet(requests));
      const out = Bun.spawnSync(["python3", "snippet.py"], { cwd: dir, env: { PATH: process.env.PATH ?? "", AI_GATEWAY_API_KEY: "from-env" } });

      expect(out.stderr.toString()).toBe("");
      const lines = out.stdout.toString().trim().split("\n");
      const captured = JSON.parse(lines[lines.length - 1]);

      expect(captured.clients).toEqual([{ api_key: "from-env", base_url: GATEWAY_BASE_URL, model: GATEWAY_MODEL }]);
      expect(captured.calls).toEqual(shown(requests));
    });

    test(`${name}: no snippet carries a key`, () => {
      for (const s of [pythonSnippet(requests), typescriptSnippet(requests), curlSnippet(requests)]) {
        expect(s).toContain("AI_GATEWAY_API_KEY");
        expect(s).not.toMatch(/Bearer [^$]/);
      }
    });
  }

  test("the CLI snippet runs studies the CLI has", () => {
    for (const study of STUDIES) {
      expect(cliSnippet(study)).toContain(`bun tools/decide-cli/cli.ts eval ${study} --endpoint jev --dry-run`);
      expect(cliSnippet(study)).not.toMatch(/AI_GATEWAY_API_KEY=[^…]/);
    }
  });
});

/** json.dumps with its default separators, which is how jev_lab hashed each request. */
const pyDumps = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(pyDumps).join(", ")}]`
    : v && typeof v === "object"
      ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`).join(", ")}}`
      : JSON.stringify(v);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("rebuilt requests match what was recorded", () => {
  test("every intent request matches its recorded hash", () => {
    const { result } = readRecord(new URL("../results/classify.jsonl", import.meta.url));
    let checked = 0;

    for (const dataset of ["banking77", "clinc150"] as const)
      for (const row of result.experiments[dataset].rows) {
        if (!row.request_hash) continue;

        expect(sha256(pyDumps({ model: GATEWAY_MODEL, ...intentRequest(dataset, row.text) }))).toBe(row.request_hash);
        checked++;
      }

    expect(checked).toBeGreaterThan(700);
  });

  test("a judgment-reliability task's questions match their recorded hash", () => {
    const pairs = new Map(
      gunzipSync(readFileSync(new URL("../../judgment-reliability/cases.jsonl.gz", import.meta.url)))
        .toString()
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Pair)
        .map((p) => [p.pair_id, p]),
    );
    const records = gunzipSync(readFileSync(new URL("../../judgment-reliability/events.jsonl.gz", import.meta.url)))
      .toString()
      .split("\n")
      .slice(0, 400)
      .filter((l) => l.includes('"request_sha256"') && l.includes('"status":"completed"'))
      .map((l) => JSON.parse(l) as Task & { request_sha256: string });

    expect(records.length).toBeGreaterThan(10);

    for (const r of records) expect(sha256(JSON.stringify(encodedQuestions(pairs.get(r.pair_id)!, r)))).toBe(r.request_sha256);
  });

  test("the recorded examples' answers are the recorded requests' questions", () => {
    for (const [name, build] of [
      ["semantic-table", recordedRequests.semanticTable],
      ["undo", recordedRequests.undo],
      ["changes", recordedRequests.changes],
    ] as const) {
      const { result } = readRecord(new URL(`../results/${name}.jsonl`, import.meta.url));

      expect(Object.keys(result.answers).sort()).toEqual(Object.keys(build().questions).sort());
    }
  });
});
