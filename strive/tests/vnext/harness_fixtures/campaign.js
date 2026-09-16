// No-spend process adapter for tests of the live campaign composition.
const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
let buffer='';
async function line() {
  while (!buffer.includes('\n')) {const part=await reader.read(); if(part.done)throw Error('closed');buffer+=part.value;}
  const i=buffer.indexOf('\n'), value=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);return value;
}
const data=await line();
const request={model:data.model,input:data.input,max_output_tokens:data.max_output_tokens,
  service_tier:'default',store:false,prompt_cache_options:{mode:'explicit'},reasoning:{effort:'low'}};
console.log(JSON.stringify({gateway_request:JSON.stringify(request),token:data.token,path:'/generation'}));
const reply=await line();
if(reply.status!==200)Deno.exit(1);
const response=JSON.parse(reply.body);
const text=response.output.filter(item=>item.type==='message')[0].content[0].text;
console.log(JSON.stringify({type:'text',part:{text}}));
Deno.exit(0);
