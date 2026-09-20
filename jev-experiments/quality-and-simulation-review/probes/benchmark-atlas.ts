// Inspect the frozen atlas record. No execution of any proposed benchmark.
import {readRecord} from '../../experience-prototypes/scripts/records';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const url=new URL('../../local-models-and-games/research-map.jsonl',import.meta.url),r=readRecord(url).result;
const entries=[...r.benchmarks,...r.ideas];
const structuredFields=['id','revision','split','expected_cases','completed_cases','scorer','request_budget','seed','evidence_path'];
const out={sha256:createHash('sha256').update(readFileSync(url)).digest('hex'),benchmarks:r.benchmarks.length,ideas:r.ideas.length,statusCounts:Object.fromEntries([...new Set(entries.map((e:any)=>e.status))].map(s=>[s,entries.filter((e:any)=>e.status===s).length])),implemented:entries.filter((e:any)=>e.status==='Implemented').map((e:any)=>({name:e.name,experiment:e.experiment})),declaredStructuredFields:Object.fromEntries(structuredFields.map(k=>[k,entries.filter((e:any)=>Object.hasOwn(e,k)).length])),benchmarkUrls:r.benchmarks.map((b:any)=>({name:b.name,url:b.url})),explicitCountProtocols:r.benchmarks.filter((b:any)=>/\d[\d,]* (validation questions|held-out test cases)/.test(b.protocol)).map((b:any)=>b.name),modelCalls:0};
writeFileSync(new URL('./benchmark-atlas.json',import.meta.url),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
