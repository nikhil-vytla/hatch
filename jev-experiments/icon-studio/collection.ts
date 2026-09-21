import {readdirSync,readFileSync,mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
export async function collection(){const base=resolve(import.meta.dir,'../experience-prototypes/node_modules/lucide-react');const pkg=JSON.parse(readFileSync(resolve(base,'package.json'),'utf8'));const icons:any[]=[];
 for(const file of readdirSync(resolve(base,'dist/esm/icons')).filter(f=>f.endsWith('.js')).sort()){
  const source=readFileSync(resolve(base,'dist/esm/icons',file),'utf8');if(!source.includes('const __iconNode ='))continue;
  const mod=await import(resolve(base,'dist/esm/icons',file));const id=file.slice(0,-3),node=mod.__iconNode;
  if(!Array.isArray(node)||node.some((n:any)=>!['path','circle','rect','line','polyline','polygon','ellipse'].includes(n[0])))throw Error(`Unsupported vector ${id}`);
  icons.push({id,label:id.replaceAll('-',' '),node});
 }
 const names=icons.map(i=>i.id),sha256=createHash('sha256').update(JSON.stringify(names)).digest('hex');return{package:pkg.name,version:pkg.version,license:pkg.license,url:'https://lucide.dev',sha256,icons};
}
if(import.meta.main){const out=resolve(process.argv[2]??'jev-experiments/experience-prototypes/public/icon-studio');mkdirSync(out,{recursive:true});const data=await collection();writeFileSync(resolve(out,'collection.json'),JSON.stringify(data)+'\n');copyFileSync(resolve(import.meta.dir,'../experience-prototypes/node_modules/lucide-react/LICENSE'),resolve(out,'LICENSE.txt'));console.log(JSON.stringify({icons:data.icons.length,version:data.version,sha256:data.sha256}));}
