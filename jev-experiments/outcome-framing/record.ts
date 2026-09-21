import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluate, GatewayError } from '../experience-prototypes/scripts/local-model';
import { writeRecord } from '../experience-prototypes/scripts/records';
import { initial, act, chooseCode, modelPolicies, policies, decisionQuestion, sharedPolicy, features, type Policy, type GameState } from './tetris';
import { SIZE, drawingCases, drawingMethods, drawingPayload, intensity, reference, drawingMetrics, type DrawingMethod } from './drawing';
const here=dirname(fileURLToPath(import.meta.url));
const mode=process.argv[2]??'prepare';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const eventsFile=resolve(here,'events.jsonl');
const events:any[]=existsSync(eventsFile)?readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
const completed=new Map<string,any>();
for(const e of events)if(e.kind==='response'){if(completed.has(e.id))throw Error(`Duplicate response ${e.id}`);completed.set(e.id,e);}
const write=(v:any)=>{events.push(v);appendFileSync(eventsFile,JSON.stringify(v)+'\n');};
async function ask(id:string,body:any){const requestHash=hash(body);if(completed.has(id)){const found=completed.get(id);if(found.requestHash!==requestHash)throw Error(`Protocol drift ${id}`);return found;}
 for(let sweep=0;sweep<8;sweep++){
  write({kind:'request',id,requestHash,at:new Date().toISOString(),body});
  try{const output=await evaluate(body,{deadlineMs:125000,onAttempt:a=>write({kind:'attempt',id,at:new Date().toISOString(),...a})});const e={kind:'response',id,requestHash,at:new Date().toISOString(),output};write(e);completed.set(id,e);await Bun.sleep(1100);return e;}
  catch(error){const e=error as GatewayError;write({kind:'failure',id,at:new Date().toISOString(),status:e.status,message:e.message});if(![408,429,500,502,503,504].includes(e.status))throw error;await Bun.sleep(15000);}
 }throw Error(`Provider unavailable after retries: ${id}`);
}
export const seeds=[7,19,42,73,101];
type Episode={id:string;seed:number;policy:Policy;frames:any[];state:GameState;status:string;modelDecisions:number;latencyMs:number};
function episodes():Episode[]{return seeds.flatMap(seed=>(Object.keys(policies) as Policy[]).map(policy=>({id:`${seed}/${policy}`,seed,policy,frames:[],state:initial(seed),status:'pending',modelDecisions:0,latencyMs:0})));}
function advance(e:Episode,value:string,evidence?:any){const before=e.state,after=act(before,e.policy,value);if(hash(before)===hash(after))throw Error(`No state transition: ${e.id}`);e.frames.push({before,after,value,...(evidence?{requestId:evidence.id,questionId:`game_${e.id.replace('/','_')}`,latencyMs:evidence.output.latency_ms,batchQuestions:Object.keys(evidence.output.answers).length}:{} )});e.state=after;if(evidence){e.modelDecisions++;e.latencyMs+=evidence.output.latency_ms;}e.status=after.status==='playing'?'running':'complete';}
async function tetris(record:boolean){const all=episodes();let round=0;
 while(all.some(e=>e.state.status==='playing')){
  const pending=all.filter(e=>e.state.status==='playing');
  for(const e of pending.filter(e=>!modelPolicies.includes(e.policy))){const value=chooseCode(e.state,e.policy as 'greedy'|'planner');if(!value)throw Error(`No code placement ${e.id}`);advance(e,value);}
  const models=pending.filter(e=>modelPolicies.includes(e.policy));
  const batches:{es:Episode[];body:any}[]=[];let b={es:[] as Episode[],body:{state:sharedPolicy,questions:{} as Record<string,any>}};
  for(const e of models){const key=`game_${e.id.replace('/','_')}`,q=decisionQuestion(e.state,e.policy);const body={state:sharedPolicy,questions:{...b.body.questions,[key]:q}};
   if(b.es.length&&Buffer.byteLength(JSON.stringify(body))>56000){batches.push(b);b={es:[],body:{state:sharedPolicy,questions:{}}};}
   b.es.push(e);b.body.questions[key]=q;
  }if(b.es.length)batches.push(b);
  let missing=false;
  for(let i=0;i<batches.length;i++){const batch=batches[i],id=`tetris-v1/${round}/${i}`,old=completed.get(id);if(!record&&!old){missing=true;continue;}const response=record?await ask(id,batch.body):old;if(response.requestHash!==hash(batch.body))throw Error(`Replay drift ${id}`);for(const e of batch.es)advance(e,response.output.answers[`game_${e.id.replace('/','_')}`].value,response);}
  round++;if(missing)break;
 }
 for(const e of all.filter(e=>!modelPolicies.includes(e.policy)))while(e.state.status==='playing')advance(e,chooseCode(e.state,e.policy as 'greedy'|'planner')!);
 const compact=(s:GameState)=>({...s,pieces:s.pieces.slice(0,34)});
 const result={version:'tetris-v1',model:'typesafe/jev',rules:{seeds,pieceLimit:32,buttonBudget:12,gravity:false,hold:false,tucks:false},policies,episodes:all.map(e=>({...e,state:compact(e.state),frames:e.frames.map(f=>({...f,before:compact(f.before),after:compact(f.after)})),final:features(e.state.board)})),availability:{planned:all.length,completed:all.filter(e=>e.status==='complete').length},evidence:'/outcome-framing/events.jsonl',protocol:'Broad goal and button share observations/actions. Landing and outcome share reachable placements. Outcome adds exact one-piece simulation. Two-piece future adds heuristic-guided search. Code baselines use the declared fixed heuristic. Five seeds are exploratory, not a definitive ranking. Replay speed is independent of request latency.'};
 writeRecord(resolve(here,'tetris.jsonl'),{name:'tetris-framing',result});return result;
}
async function drawing(record:boolean){const maps:any[]=[];for(const c of drawingCases)for(const method of Object.keys(drawingMethods) as DrawingMethod[]){if(method==='formula'&&!c.formula)continue;const values:number[]=[],requests:any[]=[];const stride=method==='scanline'?SIZE:64;let missing=false;
 for(let start=0;start<SIZE*SIZE;start+=stride){const id=`drawing-v1/${c.id}/${method}/${start}`,body=drawingPayload(c,method,Array.from({length:stride},(_,i)=>start+i),values),old=completed.get(id);if(!record&&!old){missing=true;break;}const response=record?await ask(id,body):old;if(response.requestHash!==hash(body))throw Error(`Replay drift ${id}`);for(let i=start;i<start+stride;i++)values.push(intensity(response.output.answers[`pixel_${i}`],method));requests.push({id,latencyMs:response.output.latency_ms,retries:response.output.retries});}
 maps.push({id:`${c.id}/${method}`,caseId:c.id,method,title:c.title,description:c.description,group:c.group,formula:c.formula,values,reference:reference(c),requests,status:missing?'pending':'complete',metrics:missing?null:drawingMetrics(values,reference(c))});
 }const result={version:'drawing-v1',size:SIZE,methods:drawingMethods,cases:drawingCases.map(({inside,...c})=>c),maps,availability:{planned:maps.length,completed:maps.filter(m=>m.status==='complete').length},evidence:'/outcome-framing/events.jsonl',protocol:'One frozen pass per case/method. Direct Score and membership Noul share the same task and coordinates. Formula provides additional information. Scanline sees its earlier predicted rows. Exact geometry is a code-solvable control; creative icons have no objective reference.'};writeRecord(resolve(here,'drawing.jsonl'),{name:'drawing-framing',result});return result;
}
if(mode==='tetris')await tetris(true);else if(mode==='drawing')await drawing(true);else if(mode==='all'){await tetris(true);await drawing(true);}else{await tetris(false);await drawing(false);}
console.log(JSON.stringify({mode,responses:completed.size,output:here}));
