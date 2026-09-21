import '../../../experience-prototypes/scripts/credentials';
import { appendFileSync,existsSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createJevAdapter } from '../../runtime/jev';
import { createDecisionClassifier } from '../classifier';
import { executeDestination } from '../execute';
import { classifyTask,defaultPolicy,selectRoute } from '../policy';
import { webRoutes } from '../web-registry';
import { grade } from './grade';
import type { Classification,Task,TaskCategory } from '../types';
const dir=import.meta.dir,tasks=JSON.parse(readFileSync(join(dir,'tasks.json'),'utf8')) as (Task&{split:string})[];
const labels=JSON.parse(readFileSync(join(dir,'labels.json'),'utf8'));
const read=(name:string):any[]=>existsSync(join(dir,name))?readFileSync(join(dir,name),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const append=(name:string,row:unknown)=>appendFileSync(join(dir,name),JSON.stringify(row)+'\n');
const alternativePath=join(dir,'alternative-access.json');
const alternative=existsSync(alternativePath)?JSON.parse(readFileSync(alternativePath,'utf8')).selected:null;
const activeRoutes=alternative?[webRoutes[0],alternative]:webRoutes;
const phase=process.argv[2]??'matrix';
if(phase==='matrix') {
 if(!existsSync(join(dir,'host-classifications.json')))throw Error('Freeze host traits before destination outcomes.');
 if(!process.env.AI_GATEWAY_API_KEY)throw Error('AI_GATEWAY_API_KEY required.');
 const seen=new Set(read('matrix.jsonl').map(r=>r.taskId+'|'+r.routeId));
 for(const task of tasks)for(const source of activeRoutes){
  if(seen.has(task.id+'|'+source.id))continue;
  const route={...source,destination:{kind:'openai-compatible' as const,endpoint:source.destination.kind==='openai-compatible'?source.destination.endpoint:'',apiKeyEnv:'AI_GATEWAY_API_KEY'}};
  const at=performance.now();const result=await executeDestination(route,{...task,outputTokens:1024},{outputTokens:1024,signal:AbortSignal.timeout(60_000)});
  const row={taskId:task.id,split:task.split,routeId:route.id,latencyMs:performance.now()-at,result,grade:grade(task.id,result.status==='ok'?result.artifact:undefined),costBasis:'Configured gateway list prices times provider-reported token usage; no invoice verified.'};
  append('matrix.jsonl',row);console.log(JSON.stringify({taskId:task.id,routeId:route.id,status:result.status,pass:row.grade.pass}));
 }
} else if(phase==='hosted') {
 if(!process.env.AI_GATEWAY_API_KEY)throw Error('AI_GATEWAY_API_KEY required.');
 const seen=new Set(read('hosted.jsonl').map(r=>r.taskId));
 for(const task of tasks){
  if(seen.has(task.id))continue;
  const underlying=createJevAdapter(process.env.AI_GATEWAY_API_KEY);let response:unknown;
  const adapter={...underlying,async decide(...args:Parameters<typeof underlying.decide>){response=await underlying.decide(...args);return response as Awaited<ReturnType<typeof underlying.decide>>}};
  const at=performance.now();try{const classification=await createDecisionClassifier(adapter).classifier(task,AbortSignal.timeout(60_000));append('hosted.jsonl',{taskId:task.id,split:task.split,status:'ok',classification,response,durationMs:performance.now()-at,costUsd:null});console.log(JSON.stringify({taskId:task.id,status:'ok'}))}catch(e){append('hosted.jsonl',{taskId:task.id,split:task.split,status:'error',error:e instanceof Error?e.message:String(e),response,durationMs:performance.now()-at,costUsd:null});console.log(JSON.stringify({taskId:task.id,status:'error'}))}
 }
} else if(phase==='replay') {
 const matrix=read('matrix.jsonl'),hosted=read('hosted.jsonl'),local=read('local.jsonl'),host=JSON.parse(readFileSync(join(dir,'host-classifications.json'),'utf8'));
 if(tasks.some(task=>activeRoutes.some((route:any)=>!matrix.some(row=>row.taskId===task.id&&row.routeId===route.id))))throw Error('Destination matrix is incomplete.');
 const median=(ns:number[])=>[...ns].sort((a,b)=>a-b)[Math.floor(ns.length/2)];
 const categories:TaskCategory[]=['bug-fix','test-writing','repository-analysis','writing','other'];
 const registry=activeRoutes.map((route:any)=>{const rows=matrix.filter(r=>r.routeId===route.id&&r.split==='calibration'),q=(rows.filter(r=>r.grade.pass).length+1)/(rows.length+2);return {...route,quality:{value:q,basis:'measured' as const,evidence:'4 calibration synthetic fixtures, Laplace smoothed.'},taskQuality:Object.fromEntries(categories.map(c=>[c,{easy:q,hard:q,basis:'measured' as const,evidence:'Aggregate calibration score; insufficient data for category/difficulty fitting.'}])),latencyMs:{value:median(rows.map(r=>r.latencyMs)),basis:'measured' as const,evidence:'Median over4 calibration fixture calls.'}}});
 const calibrated={registry,policy:defaultPolicy,calibrationIds:tasks.filter(t=>t.split==='calibration').map(t=>t.id)};
 writeFileSync(join(dir,'calibrated-registry.json'),JSON.stringify(calibrated,null,2)+'\n');
 const rows:any[]=[];
 for(const task of tasks.filter(t=>t.split==='heldout')) {
  const localRow=local.find(r=>r.taskId===task.id),hostedRow=hosted.find(r=>r.taskId===task.id);
  const decisions=localRow?.response?.decisions;
  const ld=decisions?.find((d:any)=>d.questionId==='category'),dd=decisions?.find((d:any)=>d.questionId==='difficulty');
  const hostValues=host.classifications[task.id]??host.classifications.find?.((c:any)=>c.id===task.id||c.taskId===task.id);
  const heuristicStarted=performance.now(),heuristic=classifyTask(task),heuristicMs=performance.now()-heuristicStarted;
  const conditions:{name:string;classification?:Classification;overheadMs:number|null;overheadCost:number|null;response?:any}[]=[
   {name:'heuristic',classification:heuristic,overheadMs:heuristicMs,overheadCost:0},
   {name:'host-agent',classification:hostValues?{...hostValues,source:'host',latencyMs:0,costUsd:null,evidence:'Frozen root host judgment before destination outcomes.'}:undefined,overheadMs:null,overheadCost:null},
   {name:'hosted-jev',classification:hostedRow?.classification,overheadMs:hostedRow?.durationMs??null,overheadCost:null,response:hostedRow?.response},
   {name:'local-laya',classification:ld&&dd?{source:'local',category:ld.selected,difficulty:Number(dd.selected),confidence:Math.max(...ld.distribution.map((p:any)=>p.probability)),latencyMs:localRow.durationMs,costUsd:0,evidence:'Frozen experimental Laya. Cold CLI invocation including checksum and loading.'}:undefined,overheadMs:localRow?.durationMs??null,overheadCost:0,response:localRow?.response},
  ];
  for(const route of registry){const observed=matrix.find(r=>r.taskId===task.id&&r.routeId===route.id);rows.push({condition:'fixed-'+route.id,taskId:task.id,routeId:route.id,covered:observed.result.status==='ok',selectionCovered:true,destinationStatus:observed.result.status,success:observed.grade.pass,replayedDestinationLatencyMs:observed.latencyMs,classifierOverheadMs:0,totalLatencyMs:observed.latencyMs,pricedUsageUsd:observed.result.costUsd,totalCostUsd:observed.result.costUsd,selectionSource:'Fixed baseline'})}
  for(const condition of conditions){
   const selectionStarted=performance.now();
   const selection=condition.classification?selectRoute({...task,outputTokens:1024},registry,defaultPolicy,{classification:condition.classification}):null;
   const selectionLatencyMs=performance.now()-selectionStarted;
   const observed=selection?.routeId?matrix.find(r=>r.taskId===task.id&&r.routeId===selection.routeId):null;
   const categoryDistribution=condition.response?.decisions?.find((d:any)=>d.questionId==='category')?.distribution;
   const brier=categoryDistribution?categoryDistribution.reduce((s:number,p:any)=>s+(p.probability-Number(p.value===labels[task.id].category))**2,0):null;
   rows.push({condition:condition.name,taskId:task.id,routeId:selection?.routeId??null,classification:condition.classification??null,covered:observed?.result.status==='ok',selectionCovered:Boolean(observed),destinationStatus:observed?.result.status??'not-run',success:observed?.grade.pass??false,categoryCorrect:condition.classification?.category===labels[task.id].category,difficultyAbsoluteError:condition.classification?Math.abs(condition.classification.difficulty-labels[task.id].difficulty):null,categoryBrier:brier,classifierOverheadMs:condition.overheadMs,replayedDestinationLatencyMs:observed?.latencyMs??null,selectionLatencyMs,totalLatencyMs:observed&&condition.overheadMs!==null?observed.latencyMs+condition.overheadMs+selectionLatencyMs:null,pricedUsageUsd:observed?.result.costUsd??null,totalCostUsd:observed&&observed.result.costUsd!==null&&condition.overheadCost!==null?observed.result.costUsd+condition.overheadCost:null,selection,source:'Offline replay of one actual destination response per model/task'})
  }
 }
 const summaries=[...new Set(rows.map(r=>r.condition))].map(condition=>{const subset=rows.filter(r=>r.condition===condition);return{condition,tasks:subset.length,covered:subset.filter(r=>r.covered).length,success:subset.filter(r=>r.success).length,totalLatencyMs:subset.every(r=>r.totalLatencyMs!==null)?subset.reduce((s,r)=>s+r.totalLatencyMs,0):null,totalCostUsd:subset.every(r=>r.totalCostUsd!==null)?subset.reduce((s,r)=>s+r.totalCostUsd,0):null,categoryCorrect:subset.filter(r=>r.categoryCorrect).length,meanCategoryBrier:subset.every(r=>typeof r.categoryBrier==='number')?subset.reduce((s,r)=>s+r.categoryBrier,0)/subset.length:null}});
 const report={protocol:'Bounded routing comparison v1',generatedAt:new Date().toISOString(),mode:'offline policy replay of recorded answers',limitations:['4 calibration and4 held-out synthetic tasks cannot establish model superiority or savings.','Aggregate task-quality calibration is flat across category and difficulty, so this study cannot measure a classifier-induced quality benefit.','Host incremental latency/cost and hosted Jev price are unknown.','Configured token-price arithmetic is not verified invoice cost.'],summaries,rows};
 writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(summaries,null,2));
} else throw Error('Use matrix, hosted or replay.');
