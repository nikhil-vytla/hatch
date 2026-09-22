import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root=process.env.JEV_GATEWAY_REVIEW_SOURCE!, {evaluate}=await import(resolve(root,"jev-experiments/experience-prototypes/server/gateway.ts"));
const {usageIssue,accountingIssue}=await import(resolve(root,"jev-experiments/roadmap/runtime/accounting.ts"));
const payload={state:"authored fixture",questions:{q:{type:"noul",instructions:"ready"}}};
const response=(usage:any={input_tokens:10,output_tokens:4,total_tokens:14})=>Response.json({model:"authored-model",answers:{q:{type:"noul",noul:.75}},usage,provider_metadata:{gateway:{cost:"0.001"}}});
const rows:any[]=[];
for(const observer of ["attempt","accounting"]){const controller=new AbortController();let calls=0;const result=await evaluate(payload,{apiKey:"authored-key",signal:controller.signal,fetcher:(async()=>{calls++;return response();}) as typeof fetch,onAttempt:observer==="attempt"?()=>controller.abort():undefined,onAccounting:observer==="accounting"?(a:any)=>{if(a.attempts.at(-1)?.status===200)controller.abort();}:undefined}).then((r:any)=>({disposition:"success",cost:r.cost_usd}), (e:any)=>({disposition:"error",code:e.code}));rows.push({case:`cancel-in-final-${observer}`,signalAborted:controller.signal.aborted,calls,...result});}
let calls=0;const error=await evaluate(payload,{apiKey:"authored-key",fetcher:(async()=>{calls++;return response();}) as typeof fetch,onAccounting:()=>{throw Error("authored");}}).catch((e:any)=>e);rows.push({case:"pre-dispatch-observer-failure",calls,code:error.code,accounting:error.accounting});
for(const usage of [{input_tokens:10,total_tokens:4},{output_tokens:10,total_tokens:4}]){const r=await evaluate(payload,{apiKey:"authored-key",fetcher:(async()=>response(usage)) as typeof fetch});rows.push({case:"incoherent-partial-usage",reported:usage,returned:r.usage,issues:r.attempts[0].issues,accountingIssue:accountingIssue(r.accounting)});}
writeFileSync(resolve(import.meta.dir,"observations.json"),JSON.stringify(rows,null,2)+"\n");
