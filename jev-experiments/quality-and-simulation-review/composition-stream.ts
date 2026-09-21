export async function* compositionEvents(stream:ReadableStream<Uint8Array>, signal:AbortSignal){
 const reader=stream.getReader(),decoder=new TextDecoder();let pending='';
 try{while(true){if(signal.aborted)throw new DOMException('Stopped','AbortError');const{value,done}=await reader.read();if(signal.aborted)throw new DOMException('Stopped','AbortError');pending+=decoder.decode(value,{stream:!done});let cut:number;while((cut=pending.indexOf('\n'))>=0){const raw=pending.slice(0,cut).trim();pending=pending.slice(cut+1);if(raw)yield JSON.parse(raw);}if(done){if(pending.trim())yield JSON.parse(pending);break;}}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
