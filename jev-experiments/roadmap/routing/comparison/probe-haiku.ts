import '../../../experience-prototypes/scripts/credentials';
import {artifactResponseFormat} from '../artifacts';
import {writeFileSync} from 'node:fs';
const response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.AI_GATEWAY_API_KEY}`},body:JSON.stringify({model:'anthropic/claude-haiku-4.5',messages:[{role:'user',content:'Return a JSON object with kind answer and text hello.'}],max_tokens:32,temperature:0,response_format:artifactResponseFormat})});
const data=await response.json() as any;
const report={purpose:'One separate adapter compatibility diagnosis after the frozen matrix; not a reroll or replacement matrix answer.',httpStatus:response.status,error:typeof data.error?.message==='string'?data.error.message:typeof data.error==='string'?data.error:null,code:data.error?.code??null};
writeFileSync(new URL('./haiku-compatibility.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
