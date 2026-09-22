import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  validateRequest,
  validateResponse,
  type DecisionRequest,
} from "../runtime/contract";

const directory = fileURLToPath(new URL("../mac", import.meta.url));
const python = `
import json,sys
sys.path.insert(0,sys.argv[1])
import jev_local as local
request=json.load(sys.stdin)
local.validate(request)
result={'schemaVersion':'2','requestId':request['requestId'],'status':'ok',
        'execution':{'adapter':'fixture','model':'fixture','local':True},
        'timing':{'totalMs':0},'issues':[],
        'decisions':[local.decision(request['questions'][0],[False,True],[.65,.35]),
                     local.decision(request['questions'][1],[10,20,30],[.1,.2,.7])]}
print(json.dumps({'limits':local.LIMITS,'result':result}))
`;

test("Python local v2 outputs satisfy the shared contract without losing primitive summaries", () => {
  const request: DecisionRequest = {
    schemaVersion: "2",
    requestId: "python-contract",
    state: "Authored conformance fixture",
    questions: [
      { id: "boolean", kind: "boolean", prompt: "Does the condition hold?" },
      { id: "ordinal", kind: "ordinal", prompt: "Rate", min: 10, max: 30, step: 10 },
    ],
  };
  const completed = Bun.spawnSync(["python3", "-c", python, directory], {
    stdin: Buffer.from(JSON.stringify(request)),
  });
  expect(completed.exitCode).toBe(0);
  const { limits, result } = JSON.parse(completed.stdout.toString());
  expect(validateRequest(request, limits)).toEqual([]);
  expect(validateResponse(request, result)).toEqual([]);
  expect(result.decisions[0].selected).toBe(false);
  expect(result.decisions[0].probabilityTrue).toBe(.35);
  expect(result.decisions[1].selected).toBe(30);
  expect(result.decisions[1].expected).toBe(26);
  expect(result.decisions[1].legend.map((item: { value: number }) => item.value)).toEqual([10, 20, 30]);

  const structured: DecisionRequest = {
    ...request,
    questions: [{ id: "unsupported", kind: "boolean", prompt: "Check", criteria: { true: "Yes", false: "No" } }],
  };
  expect(validateRequest(structured, limits).length).toBeGreaterThan(0);
});

test("fractional ordinal values retain the exact identities declared by the shared contract", () => {
  const request: DecisionRequest = {
    schemaVersion: "2", requestId: "fractional-levels", state: "Fixture",
    questions: [{ id: "q", kind: "ordinal", prompt: "Rate", min: .1, max: .4, step: .1 }],
  };
  const source = `
import json,sys
sys.path.insert(0,sys.argv[1])
import jev_local as local
request=json.load(sys.stdin)
q=request['questions'][0]
print(json.dumps(local.decision(q,[value for value,_ in local.options(q)],[.1,.2,.6,.1])))
`;
  const completed = Bun.spawnSync(["python3", "-c", source, directory], { stdin: Buffer.from(JSON.stringify(request)) });
  expect(completed.exitCode).toBe(0);
  const decision = JSON.parse(completed.stdout.toString());
  expect(validateResponse(request, {
    schemaVersion: "2", requestId: request.requestId, status: "ok", decisions: [decision],
    execution: { adapter: "fixture", model: "fixture", local: true }, timing: { totalMs: 0 }, issues: [],
  })).toEqual([]);
  expect(decision.selected).toBe(.1 + 2 * .1);
});
