// Exhaustive offline checks of the original 81-state recorded policy.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readRecord } from "../../experience-prototypes/scripts/records";
const app=new URL("../../experience-prototypes/",import.meta.url),root=new URL("../../../",import.meta.url);
const source=readFileSync(new URL("src/journeys.tsx",app),"utf8");
const old=Bun.spawnSync(["git","show","4c0c40d:jev-experiments/experience-prototypes/src/journeys.tsx"],{cwd:root.pathname}).stdout.toString();assert.equal(source,old);
const doc=readRecord(new URL("results/journeys.jsonl",app)),record=doc.result;
const code=new Bun.Transpiler({loader:"tsx",tsconfig:JSON.stringify({compilerOptions:{jsx:"react",jsxFactory:"__auditElement",jsxFragmentFactory:"__fragment"}})}).transformSync(source.slice(source.indexOf("export const drinkMenu"))).replace(/\bexport\s+/g,"");
function harness(input=record){
 const slots:any[]=[];let cursor=0,tree:any;
 const ctx:any={__auditElement:(type:any,props:any,...children:any[])=>({type,props:{...props,children}}),__fragment:"fragment",useState:(v:any)=>{const i=cursor++;if(!(i in slots))slots[i]=v;return[slots[i],(x:any)=>slots[i]=typeof x==="function"?x(slots[i]):x]},motion:{div:"motion.div"},pretty:(s:string)=>s.replaceAll("_"," "),choice:(instructions:string,criteria:any)=>({type:"choice",instructions,criteria}),...Object.fromEntries(["Pane","Button","Notice","State","Stat","AnimatePresence","ArrowLeft","ArrowRight","Check"].map(n=>[n,n]))};
 vm.runInNewContext(code+"\nthis.component=Journeys;this.menu=drinkMenu;this.states=journeyStates();this.key=journeyKey;this.match=matchingDrinks;this.questions=journeyQuestions(this.states)",ctx);
 const nodes=(v:any):any[]=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==="object"?[v,...nodes(v.props?.children)]:[];
 const text=(v:any):string=>Array.isArray(v)?v.map(text).join(""):v&&typeof v==="object"?text(v.props?.children):v==null?"":String(v);
 const render=()=>{cursor=0;tree=ctx.component({record:input})};const all=()=>nodes(tree),find=(type:string)=>all().find(n=>n.type===type);render();
 return{ctx,render,all,find,state:()=>JSON.parse(JSON.stringify(find("State").props.value)),button:(label:string)=>all().find(n=>n.type==="Button"&&text(n.props.children).includes(label)),text};
}
const ref=harness(),menu=JSON.parse(JSON.stringify(ref.ctx.menu)),states=JSON.parse(JSON.stringify(ref.ctx.states)),properties=["hot","caffeine","dairy","sweet"];
assert.deepEqual(states,record.states);
const audits=Object.entries(states).map(([id,s]:any)=>{
 const counts=Object.fromEntries(properties.filter(k=>s.preferences[k]===undefined).map(k=>[k,s.matching_drinks.filter((n:string)=>menu[n][k]).length]));
 const imbalance=(k:string)=>Math.abs(2*counts[k]-s.matching_drinks.length);
 const next=record.answers[id]?.value,n=s.matching_drinks.length;
 const valid=n===0?next==="conflict":n===1?next==="done":Object.hasOwn(counts,next);
 const best=n>1?Object.keys(counts).filter(k=>imbalance(k)===Math.min(...Object.keys(counts).map(imbalance))):[];
 return{id,remaining:n,next,valid,best,optimal:n<=1?valid:best.includes(next),nonSplitting:n>1&&Object.hasOwn(counts,next)&&(counts[next]===0||counts[next]===n)};
});
const profiles=Array.from({length:16},(_,i)=>Object.fromEntries(properties.map((k,b)=>[k,!!(i&(1<<b))])));
const traces=profiles.map(profile=>{
 const h=harness(),trace:any[]=[];
 for(let step=0;step<5;step++){
  const s=h.state();trace.push(s);
  if(s.remaining.length<=1)break;
  const next=s.jev_decision?.value, buttons=h.all().filter(n=>n.type==="Button");
  if(!properties.includes(next)||s.preferences[next]!==undefined)break;
  buttons[profile[next]?0:1].props.onClick();h.render();
 }
 const final=h.state(),feasible=ref.ctx.match(profile),recommendation=final.remaining.length===1?final.remaining[0]:null;
 return{profile,feasible:Array.from(feasible),trace:trace.map(s=>({key:s.state,next:s.jev_decision?.value,remaining:s.remaining})),questions:Object.keys(final.preferences).length,recommendation,allPreferencesSatisfied:recommendation?properties.every(k=>menu[recommendation][k]===profile[k]):feasible.length===0};
});
const back=harness();back.all().filter(n=>n.type==="Button")[0].props.onClick();back.render();const answered=back.state();back.button("Change my last answer").props.onClick();back.render();assert.equal(back.state().state,"sxxxx");
const visited=new Set(traces.flatMap(t=>t.trace.map(s=>s.key)));
const codeOverride=harness({...record,answers:{...record.answers,s100x:{...record.answers.s100x,value:"conflict"}}});
codeOverride.all().filter(n=>n.type==="Button")[0].props.onClick();codeOverride.render(); // hot yes, then dairy no
codeOverride.all().filter(n=>n.type==="Button")[1].props.onClick();codeOverride.render(); // then caffeine no
codeOverride.all().filter(n=>n.type==="Button")[1].props.onClick();codeOverride.render();
const terminalOverride={state:codeOverride.state(),visibleHeading:codeOverride.text(codeOverride.find("h2"))};
const result={method:"Shared readRecord plus exhaustive original helpers and actual rendered callback transitions through mocked React hooks. No browser/model calls. Full-profile compatibility is an explicitly different task from identifying one of the eight menu items.",baselineCommit:"4c0c40d",sourceUnchanged:true,sourceHash:createHash("sha256").update(source).digest("hex"),evidenceHash:createHash("sha256").update(readFileSync(new URL("results/journeys.jsonl",app))).digest("hex"),evidence:{requests:1,questions:Object.keys(record.answers).length,states:Object.keys(states).length,stateCounts:{conflict:audits.filter(a=>a.remaining===0).length,one:audits.filter(a=>a.remaining===1).length,multiple:audits.filter(a=>a.remaining>1).length},valid:audits.filter(a=>a.valid).length,optimal:audits.filter(a=>a.optimal).length,nonOptimal:audits.filter(a=>!a.optimal),nonSplitting:audits.filter(a=>a.nonSplitting),latencyMs:record.latency_ms,attempts:record.attempts,payloadBytes:Buffer.byteLength(JSON.stringify({state:{menu,states},questions:ref.ctx.questions}))},rollouts:{profiles:16,feasibleProfiles:traces.filter(t=>t.feasible.length>0).length,fullPreferenceCorrect:traces.filter(t=>t.allPreferencesSatisfied).length,noMatchDetected:traces.filter(t=>!t.recommendation&&t.feasible.length===0).length,meanQuestions:traces.reduce((s,t)=>s+t.questions,0)/16,reachableStates:visited.size,unreachableStateCount:81-visited.size,allTraces:traces},backButton:{afterAnswer:answered.state,afterBack:back.state().state},terminalOverride};
writeFileSync(new URL("journeys.json",import.meta.url),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({states:result.evidence.stateCounts,valid:result.evidence.valid,optimal:result.evidence.optimal,nonOptimal:result.evidence.nonOptimal,nonSplitting:result.evidence.nonSplitting,rollouts:{correct:result.rollouts.fullPreferenceCorrect,questions:result.rollouts.meanQuestions,reachable:visited.size},terminalOverride},null,2));
