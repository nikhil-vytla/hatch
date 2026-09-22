import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = process.env.JEV_GATEWAY_REVIEW_SOURCE;
if (!root) throw Error("Set JEV_GATEWAY_REVIEW_SOURCE to the pinned correction archive.");
for (const [file, hash] of [
 ["jev-experiments/experience-prototypes/server/gateway.ts", "806559e60f7c17ebb25a5020b02193e3f5947dc1ad26846b61ef1ff0604dd471"],
 ["jev-experiments/roadmap/runtime/accounting.ts", "119dad69a0b24a4b1968f33737b8c5dd809e3452201664b0d55e6f9f84dc77b1"],
]) if (createHash("sha256").update(readFileSync(resolve(root,file))).digest("hex") !== hash) throw Error("Correction source changed.");
const {evaluate,GatewayError}=await import(resolve(root,"jev-experiments/experience-prototypes/server/gateway.ts"));
const {usageIssue,accountingIssue}=await import(resolve(root,"jev-experiments/roadmap/runtime/accounting.ts"));
const payload={state:"authored",questions:{q:{type:"noul",instructions:"ready"}}};
const body=(usage:unknown={input_tokens:10,output_tokens:4,total_tokens:14})=>({model:"observed-fixture",answers:{q:{type:"noul",noul:.75}},usage,provider_metadata:{gateway:{cost:"0.001",generationId:"observed-generation"}}});
async function rejected(pending:Promise<unknown>){try{await pending;}catch(error){expect(error).toBeInstanceOf(GatewayError);return error as InstanceType<typeof GatewayError>;}throw Error("Expected rejection");}
test("final-observer cancellation retains every real paid or unknown attempt",async()=>{
 for(const observer of ["attempt","accounting"] as const)for(const earlier of ["none","paid","unknown"] as const){
  const controller=new AbortController();let calls=0;
  const cancel=(a:any)=>{if(a.status===200)controller.abort();};
  const error=await rejected(evaluate(payload,{apiKey:"authored-key",signal:controller.signal,wait:async()=>{},fetcher:(async()=>{calls++;return Response.json(earlier!=="none"&&calls===1?(earlier==="paid"?body():{}):body(),{status:earlier!=="none"&&calls===1?503:200});}) as typeof fetch,onAttempt:observer==="attempt"?cancel:undefined,onAccounting:observer==="accounting"?(a:any)=>cancel(a.attempts.at(-1)):undefined}));
  expect(error.code).toBe("cancelled");expect(error.status).toBe(499);expect(calls).toBe(earlier==="none"?1:2);
  const accounting=error.accounting,last=accounting.attempts.at(-1)!;
  expect(accounting.attempts).toHaveLength(calls);expect(last.status).toBe(200);expect(last.issues).toContain("cancelled");
  expect(last.model).toBe("observed-fixture");expect(last.modelSource).toBe("provider-reported");expect(last.generationId).toBe("observed-generation");
  expect(last.costUsd).toBe(.001);expect(last.usage).toEqual({inputTokens:10,outputTokens:4,totalTokens:14});
  expect(accounting.costUsd).toBe(earlier==="unknown"?null:earlier==="paid"?.002:.001);
  expect(accounting.usage).toEqual(earlier==="unknown"?null:earlier==="paid"?{inputTokens:20,outputTokens:8,totalTokens:28}:{inputTokens:10,outputTokens:4,totalTokens:14});
  expect(accountingIssue(accounting)).toBeNull();
 }
});
test("pending-observer throw or abort removes only the undispatched attempt",async()=>{
 for(const action of ["throw","abort"] as const)for(const earlier of ["none","paid","unknown"] as const){
  const controller=new AbortController();let calls=0;
  const error=await rejected(evaluate(payload,{apiKey:"authored-key",signal:controller.signal,wait:async()=>{},fetcher:(async()=>{calls++;return Response.json(earlier==="paid"?body():{},{status:503});}) as typeof fetch,onAccounting:(a:any)=>{if(a.attempts.length===(earlier==="none"?1:2)&&a.attempts.at(-1).status==="pending"){if(action==="abort")controller.abort();else throw Error("authored observer failure");}}}));
  expect(error.code).toBe(action==="abort"?"cancelled":"observer_error");expect(calls).toBe(earlier==="none"?0:1);
  expect(error.accounting.attempts).toHaveLength(calls);expect(error.accounting.costUsd).toBe(earlier==="none"?0:earlier==="paid"?.001:null);
  expect(error.accounting.usage).toEqual(earlier==="paid"?{inputTokens:10,outputTokens:4,totalTokens:14}:null);
  expect(accountingIssue(error.accounting)).toBeNull();
 }
});
test("partial usage rejects impossible totals without inventing missing fields or losing charge",async()=>{
 const cases=[
  {wire:{input_tokens:10,total_tokens:4},valid:false,usage:null},
  {wire:{output_tokens:10,total_tokens:4},valid:false,usage:null},
  {wire:{input_tokens:0,total_tokens:0},valid:true,usage:{inputTokens:0,totalTokens:0}},
  {wire:{output_tokens:4,total_tokens:10},valid:true,usage:{outputTokens:4,totalTokens:10}},
  {wire:{input_tokens:10,output_tokens:4},valid:true,usage:{inputTokens:10,outputTokens:4}},
  {wire:{total_tokens:10},valid:true,usage:{totalTokens:10}},
 ];
 for(const c of cases){const result=await evaluate(payload,{apiKey:"authored-key",fetcher:(async()=>Response.json(body(c.wire))) as typeof fetch});
  expect(result.answers.q.value).toBe(.75);expect(result.cost_usd).toBe(.001);expect(result.accounting.usage).toEqual(c.usage);
  expect(result.attempts[0].issues.includes("invalid_usage")).toBe(!c.valid);expect(accountingIssue(result.accounting)).toBeNull();
 }
 expect(usageIssue({inputTokens:10,totalTokens:4})).not.toBeNull();expect(usageIssue({outputTokens:10,totalTokens:4})).not.toBeNull();
});
