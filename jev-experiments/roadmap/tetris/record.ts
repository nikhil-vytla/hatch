import '../../experience-prototypes/scripts/credentials';
import {evaluate} from '../../experience-prototypes/server/gateway';
import {TetrisSession,type Ticket} from '../../live-worlds/tetris/session';
import {appendFileSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const key=process.env.AI_GATEWAY_API_KEY;
if(!key)throw Error('Set AI_GATEWAY_API_KEY to run the live matched-queue study.');
const protocolSha256=createHash('sha256').update(readFileSync(new URL('./PROTOCOL.md',import.meta.url))).digest('hex');
const records=new URL('./games.jsonl',import.meta.url),summaries:any[]=[];
if(existsSync(records))throw Error('Recording already exists. Preserve it; do not overwrite recorded outcomes.');
for(const seed of [7,19,42]){
 const session=new TetrisSession(seed),inflight=new Map<string,{abort:AbortController,work:Promise<void>}>();
 session.configure(0,{source:'jev',framing:'button',assisted:false});session.configure(1,{source:'jev',framing:'landing',assisted:false});
 session.play();const start=performance.now();let previous=start,lastReport=start;
 const send=(t:Ticket)=>{
  const abort=new AbortController(),at=performance.now();
  const work=(async()=>{try{const response=await evaluate(t.request,{apiKey:key,signal:abort.signal});session.receive(t,response.answers.decision.value,performance.now()-at,undefined,response,200)}catch(e:any){session.receive(t,undefined,performance.now()-at,e.message,{error:e.message,status:e.status??null,attempts:e.attempts??[]},e.status)}finally{inflight.delete(t.id)}})();
  inflight.set(t.id,{abort,work});
 };
 while(session.running&&performance.now()-start<240_000){
  const now=performance.now();session.advance(now-previous);previous=now;
  for(const t of session.requests(true))send(t);
  if(now-lastReport>30_000){lastReport=now;console.log(JSON.stringify({seed,worldMs:session.pair.clockMs,lanes:session.pair.lanes.map(l=>({status:l.game.status,lines:l.game.lines,pieces:l.game.pieces,accepted:l.stats.accepted,stale:l.stats.stale}))}));}
  await Bun.sleep(20);
 }
 const censored=session.pair.lanes.some(l=>l.game.status==='playing');session.pause();
 const pending=[...inflight.values()];pending.forEach(p=>p.abort.abort());await Promise.allSettled(pending.map(p=>p.work));
 const summary={seed,protocolSha256,wallMs:performance.now()-start,worldMs:session.pair.clockMs,censored,lanes:session.pair.lanes.map(l=>({settings:l.settings,status:l.game.status,lines:l.game.lines,pieces:l.game.pieces,score:l.game.score,stats:l.stats})),attempts:session.events.length,knownCostUsd:session.events.reduce((n,e:any)=>n+(typeof e.response?.cost_usd==='number'?e.response.cost_usd:0),0),unknownCostRequests:session.events.filter((e:any)=>typeof e.response?.cost_usd!=='number').length};
 appendFileSync(records,JSON.stringify({summary,events:session.events})+'\n');summaries.push(summary);writeFileSync(new URL('./summary.json',import.meta.url),JSON.stringify({protocolSha256,completeSeeds:summaries.length,plannedSeeds:3,games:summaries},null,2)+'\n');console.log(JSON.stringify(summary));
}
