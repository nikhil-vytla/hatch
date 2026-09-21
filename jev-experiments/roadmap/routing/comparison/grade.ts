import type { Artifact } from '../types';
export function grade(id:string,artifact?:Artifact):{pass:boolean;reason:string} {
 if(!artifact)return{pass:false,reason:'No artifact.'};
 let x:any;try{x=JSON.parse(artifact.text)}catch{return{pass:false,reason:'Artifact text is not the requested JSON.'}}
 let pass=false;
 switch(id){
  case 'cal-loop':pass=x?.operator==='<=';break;
  case 'cal-tests':pass=Array.isArray(x)&&x.length>=2&&x.length<=4&&x.every(c=>Number.isInteger(c.n)&&c.n>=0&&c.n<=20&&c.expected===c.n*(c.n+1)/2)&&x.some(c=>c.n>0);break;
  case 'cal-dag':pass=x?.cycle===false&&JSON.stringify(x?.reachable)===JSON.stringify(['a','b','c']);break;
  case 'cal-overlap':pass=JSON.stringify(x)===JSON.stringify([1,0,0,3]);break;
  case 'test-search':pass=typeof x?.replacement==='string'&&x.replacement.replace(/\s|;/g,'')==='lo=mid+1';break;
  case 'test-median':pass=Array.isArray(x)&&x.length>=2&&x.length<=4&&x.every(c=>Array.isArray(c.values)&&c.values.length>=2&&c.values.length<=6&&c.values.length%2===0&&c.values.every((n:number,i:number)=>Number.isInteger(n)&&(i===0||n>=c.values[i-1]))&&c.expected===(c.values[c.values.length/2-1]+c.values[c.values.length/2])/2)&&x.some(c=>c.expected!==c.values[c.values.length/2]);break;
  case 'test-cycle':pass=x?.cycle===true&&JSON.stringify(x?.reachable)===JSON.stringify(['a','b','c','d']);break;
  case 'test-concurrency':pass=x?.maxConcurrent===2;break;
  default:return{pass:false,reason:'Unknown fixture.'};
 }
 return{pass,reason:pass?'Independent deterministic fixture checks passed.':'Answer does not satisfy the frozen fixture checks.'};
}
