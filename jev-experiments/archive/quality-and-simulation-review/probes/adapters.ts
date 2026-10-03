// Original offline contract probe. Reuses recorded answers; never invokes a provider.
import {readRecord} from '../../experience-prototypes/scripts/records';
import {compile,decode} from '../../adapters/typescript/index';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url).pathname;
const recordURL=new URL('../../results/adapters.jsonl',import.meta.url);
const record=readRecord(recordURL),r=record.result;
const answers=r.rows[0].answers;
const schema={type:'object',required:['area','refund','missing_context'],properties:{area:{type:'string',enum:['billing','technical','account','other'],description:'Which support area applies?'},refund:{type:'boolean',description:'Is a refund requested?'},missing_context:{type:'number',minimum:0,maximum:1,description:'Is essential context missing?'}}};
const cases:Record<string,any>={};
function add(name:string,fn:(a:any)=>void){const a=structuredClone(answers);fn(a);cases[name]=a;}
add('recorded_valid',()=>{});
add('null_choice_distribution',a=>a.area.probabilities=null);
add('missing_choice_distribution',a=>delete a.area.probabilities);
add('missing_confidence',a=>delete a.area.confidence);
add('choice_disagrees_with_distribution',a=>a.area.value='technical');
add('boolean_exact_half',a=>a.refund.value=.5);
add('wrong_noul_type',a=>a.refund.value='0.5');
add('inherited_choice_constructor',a=>a.area.value='constructor');
add('extra_answer',a=>a.unrequested={type:'noul',value:1,probabilities:null,confidence:null});
add('partial_distribution',a=>a.area.probabilities={billing:1});
const python='import json,sys\nfrom jev_lab.adapters import Contract\nfrom jev_lab.semantic import decode\na=json.load(sys.stdin)["answers"]\nprint(json.dumps({"value":decode(Contract,a).model_dump(),"answers":a}))';
const commands:Record<string,string[]>={Python:[root+'.venv/bin/python','-c',python],TypeScript:['bun','run',root+'adapters/typescript/decode.ts'],Rust:[root+'adapters/rust/target/debug/jev-schemars-lab'],Go:[root+'.cache/jev-go-adapter']};
const outcomes:Record<string,any>={};
for(const [name,a] of Object.entries(cases)){
 outcomes[name]={};
 for(const [lang,cmd] of Object.entries(commands)){
  const p=Bun.spawn(cmd,{cwd:root,env:{...process.env,PYTHONPATH:root+'src'},stdin:new Blob([JSON.stringify({answers:a})]),stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  outcomes[name][lang]=exit===0?{accepted:true,...JSON.parse(stdout)}:{accepted:false,error:stderr.trim().split('\n').slice(-2).join(' ')};
 }
}
function attempt(fn:()=>any){try{return {accepted:true,result:fn()}}catch(e){return {accepted:false,error:String(e)}}}
function score(levels:any[]){return {type:'object',required:['rating'],properties:{rating:{type:'number',minimum:0,maximum:levels.length-1,description:'Use the explicit ordered levels.', 'x-jev-levels':levels}}}}
const compileProbes={twoLevel:attempt(()=>compile(score(['deny','allow']))),threeLevel:attempt(()=>compile(score(['deny','review','allow']))),numericLevels:attempt(()=>compile(score([0,1,2]))),tooManyLevels:attempt(()=>{const q=compile(score(Array.from({length:256},(_,i)=>String(i))));return {type:q.rating.type,criteriaCount:q.rating.criteria?.length}}),duplicateEnum:attempt(()=>compile({type:'object',required:['x'],properties:{x:{type:'string',description:'Choose.',enum:['a','a']}}})),visibleSnippetMissingDescriptions:attempt(()=>compile({type:'object',required:schema.required,properties:Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,Object.fromEntries(Object.entries(v).filter(([p])=>p!=='description'))]))}))};
const rawDecode=attempt(()=>decode(schema,cases.inherited_choice_constructor));
const output={baseline:'4c0c40d5',sha256:createHash('sha256').update(readFileSync(recordURL)).digest('hex'),recordedCases:1,recordedDecisions:Object.keys(answers).length,recordedLanguages:r.rows.length,recordedValues:r.rows.map((v:any)=>({language:v.language,value:v.value,evidence_preserved:v.evidence_preserved,same_typed_value:v.same_typed_value})),compileProbes,rawDecodeInheritedOption:rawDecode,outcomes,providerCalls:0};
writeFileSync(new URL('./adapters.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({recordedCases:1,recordedLanguages:r.rows.length,compileProbes,rawDecode,acceptance:Object.fromEntries(Object.entries(outcomes).map(([k,v]:any)=>[k,Object.fromEntries(Object.entries(v).map(([lang,r]:any)=>[lang,r.accepted]))]))},null,2));
