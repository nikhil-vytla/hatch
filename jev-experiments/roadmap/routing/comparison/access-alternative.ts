import '../../../experience-prototypes/scripts/credentials';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {executeDestination} from '../execute';
import type {Route} from '../types';
const dir=import.meta.dir;
if(existsSync(join(dir,'alternative-access.json')))throw Error('Access probe already recorded; preserve it before starting a new condition.');
const catalog=await fetch('https://ai-gateway.vercel.sh/v1/models',{redirect:'error'}).then(r=>r.json()) as any;
const order=['openai/gpt-4.1','openai/gpt-4.1-nano'];
const probes=[];let selected:Route|null=null;
for(const model of order){
 const entry=catalog.data.find((m:any)=>m.id===model);if(!entry){probes.push({model,status:'missing-catalog-entry'});continue;}
 const route:Route={id:model.split('/')[1],model,available:true,local:false,capabilities:['text','coding'],tools:[],contextTokens:entry.context_window,maxOutputTokens:entry.max_tokens,quality:{value:0.5,basis:'simulation',evidence:'Unmeasured neutral prior before calibration.'},latencyMs:{value:1000,basis:'simulation',evidence:'Placeholder before calibration.'},pricing:{inputPerMillion:Number(entry.pricing.input)*1e6,outputPerMillion:Number(entry.pricing.output)*1e6,cachedInputPerMillion:Number(entry.pricing.input_cache_read??entry.pricing.input)*1e6,basis:'configured',evidence:'Vercel /v1/models retrieved at access amendment, list-price arithmetic only.'},destination:{kind:'openai-compatible',endpoint:'https://ai-gateway.vercel.sh/v1/chat/completions',apiKeyEnv:'AI_GATEWAY_API_KEY'}};
 const at=performance.now(),result=await executeDestination(route,{id:'neutral-access-probe',prompt:'Return kind answer with text ready.',context:'',outputTokens:64},{outputTokens:64,signal:AbortSignal.timeout(60_000)});
 probes.push({model,result,latencyMs:performance.now()-at});if(result.status==='ok'&&result.artifact){selected=route;break;}
}
writeFileSync(join(dir,'alternative-access.json'),JSON.stringify({frozenOrder:order,prompt:'Return kind answer with text ready.',probes,selected,selectionBasis:'First API/schema-eligible candidate, no benchmark outcome inspected.'},null,2)+'\n');
console.log(JSON.stringify({selected:selected?.id??null,probes:probes.map(p=>({model:p.model,status:'result'in p?p.result?.status:p.status}))}));
