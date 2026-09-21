// Original record and source-state probe. No inference, image download or browser automation.
import {readRecord} from '../../experience-prototypes/scripts/records';
import {recipe} from '../../web/src/recipes';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const base=new URL('../../',import.meta.url);
const hash=(b:any)=>createHash('sha256').update(b).digest('hex');
const doc=readRecord(new URL('results/vision.jsonl',base)),row=doc.result.rows[0];
const png=readFileSync(new URL('web/public/vision-input.png',base));
const react=readFileSync(new URL('experience-prototypes/src/misc.tsx',base),'utf8').split('export function Vision')[1].split('const adapterExamples')[0];
const browserRequest=recipe('vision',row.text,{caption:row.description,image:'not-part-of-request'});
const newInput={description:'A website gallery with an Enter the laboratory link and experiment cards.',question:'Where can I open the experiment list?'};
// Deliberately synthetic response to demonstrate the literal object-merge behavior.
// These values are not model outputs and are not included in accuracy measures.
const syntheticReply={answers:{action:{type:'choice',value:'inspect',probabilities:{navigate:0,describe:0,inspect:1,ask:0},confidence:1},enough_evidence:{type:'noul',value:1,probabilities:null,confidence:null}},latency_ms:1,source:'live'};
const merged={...row,...syntheticReply};
const requestedFields=['image_hash','model_revision','caption_latency_ms','download_latency_ms','questions','request','generation_config'];
const output:any={baseline:'4c0c40d5',recordSha256:hash(readFileSync(new URL('results/vision.jsonl',base))),rows:doc.result.rows.length,images:new Set(doc.result.rows.map((r:any)=>r.image)).size,image:{width:png.readUInt32BE(16),height:png.readUInt32BE(20),bytes:png.length,sha256:hash(png),publishedImageSameHash:hash(readFileSync(new URL('experience-prototypes/public/vision-input.png',base)))===hash(png)},actualRecorded:{caption:row.description,model:row.local_model,device:row.device,action:row.answers.action,enough_evidence:row.answers.enough_evidence,scene:row.answers.scene,gateway_latency_ms:row.latency_ms},provenanceFieldsPresent:Object.fromEntries(requestedFields.map(k=>[k,Object.hasOwn(row,k)])),transport:doc.result.transport,archivedBrowserRequest:browserRequest,uiSource:{fileInputPresent:/type=.file./.test(react),localWorkerPresent:/new Worker/.test(react),usesSignal:/signal|AbortController/.test(react),revisionGuard:/revision|requestId/.test(react),readsEvidenceScoreForPolicy:/enough_evidence\?\.|enough_evidence\.value/.test(react)},mergeReproduction:{synthetic:true,inputSent:newInput,storedDescription:merged.description,storedTask:merged.text,storedLocalModel:merged.local_model,storedSource:merged.source,storedAnswerKeys:Object.keys(merged.answers),exactRequestRetained:Object.hasOwn(merged,'request'),captionMatchesSent:merged.description===newInput.description,taskMatchesSent:merged.text===newInput.question},providerCalls:0};
// Small primary annotation metadata only, not images or an evaluation.
if(Bun.argv.includes('--verify-external')){
 const revision='5efbb1f1b5463a575f2eb7bc30fe29e49c15f93c',groups=[];const all:any[]=[];
 for(const platform of ['desktop','mobile','web']){
  const url=`https://huggingface.co/datasets/OS-Copilot/ScreenSpot-v2/resolve/${revision}/screenspot_${platform}_v2.json`;
  const r=await fetch(url);if(!r.ok)throw Error(`${platform}: HTTP ${r.status}`);
  const text=await r.text(),rows=JSON.parse(text);all.push(...rows);
  groups.push({platform,url,bytes:Buffer.byteLength(text),sha256:hash(text),cases:rows.length,uniqueImages:new Set(rows.map((r:any)=>r.img_filename)).size,elementTypes:Object.fromEntries([...new Set(rows.map((r:any)=>r.data_type))].map(t=>[t,rows.filter((r:any)=>r.data_type===t).length]))});
 }
 output.externalMetadata={dataset:'OS-Copilot/ScreenSpot-v2',revision,groups,totalCases:all.length,uniqueImages:new Set(all.map(r=>r.img_filename)).size,evaluatedCases:0,imagesDownloaded:0};
}
writeFileSync(new URL('./vision.json',import.meta.url),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
