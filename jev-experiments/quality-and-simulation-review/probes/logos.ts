// Original Logo studio audit; no model calls or browser.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";
import { readRecord } from "../../experience-prototypes/scripts/records";
const root = new URL("../../../", import.meta.url), app = new URL("../../experience-prototypes/", import.meta.url);
const path = "jev-experiments/experience-prototypes/src/misc.tsx";
const baseline = Bun.spawnSync(["git", "show", `4c0c40d:${path}`], { cwd: root.pathname }).stdout.toString();
const current = readFileSync(new URL("src/misc.tsx", app), "utf8");
const extract = (s: string) => s.slice(s.indexOf("export function Logos"), s.indexOf("export function Decisions"));
assert.equal(extract(current), extract(baseline));
const source = extract(baseline);
const publicationPath = new URL("../results/logos.jsonl", app);
const document = readRecord(publicationPath), rows = document.result.rows, good = rows.filter((r: any) => r.spec);
const code = new Bun.Transpiler({ loader: "tsx", tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "__auditElement" } }) }).transformSync(source).replace(/\bexport\s+/g, "");
function harness(result = document.result) {
  const slots: any[] = []; let cursor = 0, tree: any, request: any, resolve: any, downloaded: any;
  const ctx: any = {
    __auditElement: (type: any, props: any, ...children: any[]) => ({type, props:{...props, children}}),
    useState: (v: any) => { const i=cursor++; if(!(i in slots))slots[i]=v; return [slots[i], (next: any)=>slots[i]=typeof next==="function"?next(slots[i]):next]; },
    useRun:()=>({busy:false,error:"",execute:(f:any)=>f()}), motion:{div:"motion.div"},
    choice:(instructions:string, options:any)=>({type:"choice", instructions, criteria:Object.fromEntries(options.map((v:string)=>[v,v.replaceAll("_"," ")]))}),
    run:(state:any,questions:any)=>{request={state,questions};return new Promise(r=>resolve=r)},
    download:(name:string,value:any,mime:string)=>downloaded={name,value,mime},
    document:{querySelector:()=>({outerHTML:serialize(all().find(n=>n.type==="svg"))})},
    ...Object.fromEntries(["Pane","Field","RunButton","Button","State","ErrorText","Download"].map(n=>[n,n]))
  };
  vm.runInNewContext(code+"\nthis.component=Logos",ctx);
  const nodes=(v:any):any[]=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==="object"?[v,...nodes(v.props?.children)]:[];
  const render=()=>{cursor=0;tree=ctx.component({result});};
  const all=()=>nodes(tree), find=(type:string)=>all().find(n=>n.type===type);
  render(); return {render,all,find,request:()=>request,resolve:(r:any)=>resolve(r),state:()=>JSON.parse(JSON.stringify(find("State").props.value)),download:()=>downloaded};
}
function serialize(node:any):string {
  if(node==null||typeof node==="boolean")return "";
  if(Array.isArray(node))return node.map(serialize).join("");
  if(typeof node!=="object")return String(node);
  const attrs=Object.entries(node.props).filter(([k,v])=>k!=="children"&&k!=="key"&&typeof v!=="function").map(([k,v])=>` ${k==="strokeWidth"?"stroke-width":k}="${v}"`).join("");
  return `<${node.type}${attrs}>${serialize(node.props.children)}</${node.type}>`;
}
const h=harness(), initial=h.state();
const pending=h.find("RunButton").props.onClick();
h.find("textarea").props.onChange({target:{value:"A playful astronomy club"}});h.render();
h.all().find(n=>n.type==="select"&&n.props.value==="teal").props.onChange({target:{value:"coral"}});h.render();
const manualBeforeReply=h.state();h.resolve({answers:good[0].answers});await pending;h.render();
const afterReply=h.state();
h.all().find(n=>n.type==="button"&&n.props.key==="orbit").props.onClick();h.render();
const afterManualStructure=h.state();h.find("Button").props.onClick();
assert.equal(afterReply.spec.palette,"teal");assert.equal(manualBeforeReply.spec.palette,"coral");
assert.equal(h.find("textarea").props.value,"A playful astronomy club");
assert.equal(afterManualStructure.spec.structure,"orbit");assert.equal(afterManualStructure.run.answers.structure.value,"single");
const combinations:any[]=[];
for(const symbol of ["leaf","star","wave","mountain","circle"])for(const palette of ["teal","coral","violet","ink"])for(const structure of ["single","paired","nested","orbit"])for(const weight of ["light","medium","bold"]){
 const spec={symbol,palette,structure,weight}, x=harness({rows:[{brief:"audit",spec}]});
 const svg=serialize(x.all().find(n=>n.type==="svg"));
 combinations.push({spec,svg,strokeAt16px:(weight==="light"?3:weight==="medium"?5:9)*(structure==="orbit"?.45:structure==="paired"?.7:1)*16/200});
}
const out={
 method:"Frozen original component callback probe with mocked React hooks, element serialization and deferred results; no real browser, rasterization or provider requests. SVG serialization tests structure, not optical quality.",
 baselineCommit:"4c0c40d",currentBlockUnchanged:true,sourceHash:createHash("sha256").update(source).digest("hex"),evidenceHash:createHash("sha256").update(readFileSync(publicationPath)).digest("hex"),
 evidence:{attempted:rows.length,completed:good.length,decisions:good.length*4,failures:rows.filter((r:any)=>!r.spec),structureCounts:Object.fromEntries(["single","paired","nested","orbit"].map(v=>[v,good.filter((r:any)=>r.spec.structure===v).length])),weightCounts:Object.fromEntries(["light","medium","bold"].map(v=>[v,good.filter((r:any)=>r.spec.weight===v).length])),transport:document.result.transport,recordedCases:good.map((r:any)=>({brief:r.brief,spec:r.spec,latency_ms:r.latency_ms}))},
 initialInspector:initial,renderedRecordedBriefCount:1,
 staleResult:{requestedBrief:h.request().state,visibleBrief:h.find("textarea").props.value,manualBeforeReply,afterReply},
 manualProvenance:{afterManualStructure,briefRetainedInInspector:Object.hasOwn(afterManualStructure,"brief")},
 exported:{mime:h.download().mime,hasNamespace:h.download().value.includes('xmlns="http://www.w3.org/2000/svg"'),hasResolvedColor:h.download().value.includes('style="color:#587d70"'),containsBrief:h.download().value.includes("astronomy")},
 grammar:{nominalSpecifications:combinations.length,uniqueGeometryStrings:new Set(combinations.map(c=>c.svg)).size,note:"Palette is inherited outside the SVG and excluded from these geometry strings; five symbols times four structures times three weights equals sixty shapes.",smallestOrbitStrokeAt16px:3*.45*16/200,lightSingleStrokeAt16px:3*16/200,smallSizeRasterCheckPerformed:false},
};
writeFileSync(new URL("logos.json",import.meta.url),JSON.stringify(out,null,2)+"\n");
console.log(JSON.stringify({completed:good.length,attempted:rows.length,decisions:good.length*4,specifications:combinations.length,geometryStrings:out.grammar.uniqueGeometryStrings,manualPaletteLost:afterReply.spec.palette,visibleBrief:out.staleResult.visibleBrief},null,2));
