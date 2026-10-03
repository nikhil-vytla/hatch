import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readRecord } from '../../experience-prototypes/scripts/records';
import { experiments } from '../../experience-prototypes/src/catalog';
const app = resolve(import.meta.dir, '../../experience-prototypes');
const manifest = JSON.parse(readFileSync(resolve(app,'publication.json'),'utf8'));
function arrays(value: any, path = 'result'): any[] {
  if (Array.isArray(value)) return [{ path, length:value.length, errors:value.filter(v=>v && typeof v==='object' && v.error).length, sampleKeys:value[0] && typeof value[0]==='object' ? Object.keys(value[0]) : [] }];
  if (!value || typeof value!=='object') return [];
  return Object.entries(value).flatMap(([k,v])=>arrays(v,`${path}.${k}`));
}
const datasets = Object.fromEntries([...new Set([...experiments.map(e=>e.data),'composed-ui'])].map(id=>{
  const file=resolve(app,manifest[id]);
  const bytes=readFileSync(file);
  const record=readRecord(file);
  return [id,{source:manifest[id],sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,manifest:record.manifest,resultKeys:Object.keys(record.result??{}),arrays:arrays(record.result)}];
}));
await Bun.write(resolve(import.meta.dir,'../evidence-inventory.json'),JSON.stringify({sourceCommit:'4c0c40d',experiments:experiments.map(e=>({id:e.id,data:e.data})),datasets},null,2)+'\n');
console.log(`Inventoried ${experiments.length} experiments and ${Object.keys(datasets).length} distinct evidence records.`);
