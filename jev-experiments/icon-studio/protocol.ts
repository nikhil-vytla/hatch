export type LibraryIcon={id:string;label:string;node:any[]};
export const presets=[
 {id:'quiet',title:'Quiet hours',context:'A messaging app setting that pauses notifications while you rest. Avoid a clock if a clearer metaphor exists.'},
 {id:'sources',title:'Sources',context:'A research notebook tab containing original references and supporting evidence.'},
 {id:'audience',title:'Audience',context:'An email campaign dashboard showing the people who will receive a message.'},
 {id:'branch',title:'Try another direction',context:'A creative canvas action that duplicates the current draft so you can explore a different design without losing it.'},
 {id:'return',title:'Bring it back',context:'A store order page action that starts a product return and refund.'},
 {id:'weather',title:'A little brighter',context:'A photo editor button that increases image exposure. This does not change the weather.'},
];
export function shards(icons:LibraryIcon[],seed=31,size=64){const copy=[...icons];let n=seed>>>0;for(let i=copy.length-1;i>0;i--){n=(Math.imul(n,1664525)+1013904223)>>>0;const j=Math.floor(n/4294967296*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]];}return Array.from({length:Math.ceil(copy.length/size)},(_,i)=>copy.slice(i*size,(i+1)*size));}
export function shardQuestion(group:LibraryIcon[]){return{type:'choice' as const,instructions:'Select the icon whose usual visual metaphor best communicates the supplied UI label in its specific product context. Match meaning, not just a shared word. Choose none if no icon in this group is suitable.',criteria:{...Object.fromEntries(group.map(i=>[i.id,i.label])),none:'None of these icons clearly communicates the intent'}};}
export function finalQuestion(candidates:LibraryIcon[]){return{...shardQuestion(candidates),instructions:'These icons won separate candidate groups. Choose the clearest icon for the supplied UI label and product context. Avoid a misleading metaphor. Choose none if every finalist is unsuitable.'};}
export function lexical(icons:LibraryIcon[],title:string,context:string){const words=new Set((title+' '+context).toLowerCase().match(/[a-z]{3,}/g)??[]);return icons.map(icon=>({icon,score:icon.label.split(' ').filter(w=>words.has(w)).length})).sort((a,b)=>b.score-a.score||a.icon.id.localeCompare(b.icon.id));}
export function finalists(groups:LibraryIcon[][],answers:Record<string,{value:string}>){return groups.flatMap((group,i)=>{const value=answers['shard_'+i]?.value;if(value===undefined)throw Error(`Missing shard ${i}`);if(value==='none')return[];const icon=group.find(c=>c.id===value);if(!icon)throw Error('Choice outside candidate group');return[icon];});}
