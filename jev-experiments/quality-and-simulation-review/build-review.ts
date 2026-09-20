import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import inventory from './inventory.json';
const folder = import.meta.dir;
const partial = Bun.argv.includes('--partial');
const reviews:any[] = [];
const missing:string[] = [];
for (const exp of inventory.experiments) {
  const path=resolve(folder,`experiments/${exp.id}.json`);
  if (!existsSync(path)) { missing.push(exp.id); continue; }
  const r=JSON.parse(readFileSync(path,'utf8'));
  if(r.id!==exp.id || r.title!==exp.title) throw Error(`Catalog mismatch: ${exp.id}`);
  if(!['keep','repair','redesign','research-map'].includes(r.verdict)) throw Error(`Invalid verdict: ${exp.id}`);
  for(const key of ['summary','evidenceStatus','highestPriority','simulation','evaluation']) if(!r[key]) throw Error(`Missing ${exp.id}.${key}`);
  for(const key of ['findings','strengths','nextSteps','libraries','sources']) if(!Array.isArray(r[key])) throw Error(`Invalid ${exp.id}.${key}`);
  if(!r.findings.length || !r.evaluation.coverage || !r.simulation.acceptanceCriteria?.length) throw Error(`Incomplete review: ${exp.id}`);
  if(!existsSync(resolve(folder,`experiments/${exp.id}.md`))) throw Error(`Missing prose report: ${exp.id}`);
  for(const f of r.findings) if(!['P0','P1','P2'].includes(f.priority) || !f.evidence || !f.fix) throw Error(`Incomplete finding: ${exp.id}`);
  for(const s of [...r.sources,...r.libraries]) if(!/^https:\/\//.test(s.url)) throw Error(`Invalid source URL: ${exp.id}`);
  reviews.push({...r,category:exp.category,number:inventory.experiments.indexOf(exp)+1});
}
if(missing.length&&!partial) throw Error(`Missing dedicated reviews: ${missing.join(', ')}`);
const result={sourceCommit:inventory.sourceCommit,totalExperiments:inventory.experiments.length,reviewed:reviews.length,missing,reviews};
await Bun.write(resolve(folder,'review.json'),JSON.stringify(result,null,2)+'\n');
const template=readFileSync(resolve(folder,'review-template.html'),'utf8');
await Bun.write(resolve(folder,'review.html'),template.replace('/*__REVIEW_DATA__*/',JSON.stringify(result).replace(/</g,'\\u003c')));
await Bun.write(resolve(folder,'verification.json'),JSON.stringify({catalogExperiments:inventory.experiments.length,reviewed:reviews.length,missing,jsonAndMarkdownPresent:reviews.length,findings:reviews.reduce((n,r)=>n+r.findings.length,0),verdicts:Object.fromEntries(['keep','repair','redesign','research-map'].map(v=>[v,reviews.filter(r=>r.verdict===v).length]))},null,2)+'\n');
console.log(`Built review with ${reviews.length}/${inventory.experiments.length} dedicated audits.`);
