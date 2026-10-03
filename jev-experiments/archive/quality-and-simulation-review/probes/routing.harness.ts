// Original offline harness for the shared AgentExperiment component.
// Executes real JSX callbacks with mocked hooks; never imports provider code.
import { readFileSync } from "node:fs";
import vm from "node:vm";
export const app = new URL("../../experience-prototypes/", import.meta.url);
export const readApp = (path: string) => readFileSync(new URL(path, app), "utf8");
const source = readApp("src/agent-experiments.tsx");
const code = new Bun.Transpiler({ loader: "tsx", tsconfig: JSON.stringify({ compilerOptions: { jsx: "react", jsxFactory: "__auditElement" } }) })
  .transformSync(source.slice(source.indexOf("const routes"), source.indexOf("export function Beverage"))).replace(/\bexport\s+/g, "");
const journeys = readApp("src/journeys.tsx");
const menuContext: any = {};
vm.runInNewContext(new Bun.Transpiler({ loader: "tsx" }).transformSync(journeys.slice(journeys.indexOf("export const drinkMenu"), journeys.indexOf("const properties"))).replace(/\bexport\s+/g, "") + "\nthis.value = drinkMenu;", menuContext);
export function agentHarness(id: string, result: any) {
  const slots: any[] = [], effects: Array<() => void> = [];
  const requests: any[] = [];
  let cursor = 0, dirty = false, tree: any;
  const context: any = {
    React: { Fragment: "Fragment" },
    __auditElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    useState: (initial: any) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { const next = typeof value === "function" ? value(slots[i]) : value; dirty ||= next !== slots[i]; slots[i] = next; }]; },
    useMemo: (fn: () => any, deps: any[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect: (fn: () => void, deps: any[]) => { const i = cursor++, old = slots[i]; if (!old || deps.some((d, j) => d !== old[j])) { slots[i] = deps; effects.push(fn); } },
    useRun: () => ({ busy: false, error: "", execute: (fn: () => unknown) => fn() }),
    choice: (instructions: string, criteria: any) => ({ type: "choice", instructions, criteria }),
    judge: (instructions: string) => ({ type: "noul", instructions }),
    pretty: (value: unknown) => String(value ?? "").replaceAll("_", " "),
    percent: (value: number) => `${Math.round(value * 100)}%`,
    run: (state: any, questions: any) => new Promise((resolve, reject) => requests.push({ state, questions, resolve, reject })),
    motion: { article: "motion.article", div: "motion.div" }, MarkerType: { ArrowClosed: "ArrowClosed" },
    drinkMenu: menuContext.value,
    ...Object.fromEntries(["ReactFlow", "Background", "Controls", "Pane", "Field", "Button", "RunButton", "Pills", "Notice", "State", "Bars", "Stat", "ErrorText", "Availability", "FileText", "ShieldCheck"].map(name => [name, name])),
  };
  vm.runInNewContext(code + "\nthis.component = AgentExperiment; this.routes = routes; this.docs = docs;", context);
  const nodes = (value: any): any[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" ? [value, ...nodes(value.props?.children)] : [];
  const render = () => { for (let i = 0; i < 4; i++) { dirty = false; cursor = 0; tree = context.component({ id, result }); effects.splice(0).forEach(fn => fn()); if (!dirty) break; } return tree; };
  const all = () => nodes(tree), find = (type: string) => all().find(n => n.type === type);
  const text = (value: any): string => Array.isArray(value) ? value.map(text).join(" ") : value && typeof value === "object" ? text(value.props?.children) : value == null || typeof value === "boolean" ? "" : String(value);
  render();
  return { render, all, find, requests, text, inspector: () => all().filter(n => n.type === "State").at(-1)?.props.value, routes: context.routes, docs: context.docs };
}
