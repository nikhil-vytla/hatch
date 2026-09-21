import { copy, forkPair, setController, setNotice, type Checkpoint, type Controller, type Pair } from "../../live-worlds/crowd/engine";
/** Keep clock, weather, needs, positions, queues and policy equal; change only the notice. */
export function compareNotices(from: Checkpoint, id: string, notices: [string, string], controller: Extract<Controller, "notice" | "jev">, lane: "a" | "b" = "a"): Pair {
  const pair = forkPair(from, id, "Paired notice comparison"), source = copy(pair[lane]);
  for (const [side, text] of [["a", notices[0]], ["b", notices[1]]] as const) {
    pair[side] = copy(source); pair[side].id = `${id}:${side.toUpperCase()}`;
    setController(pair[side], controller, false); setNotice(pair[side], text);
  }
  return pair;
}
export function routeDifferences(pair: Pair) {
  return pair.a.residents.map(a => { const b = pair.b.residents.find(r => r.id === a.id)!; return { id: a.id, name: a.name, a: a.target, b: b.target, sourceA: a.source, sourceB: b.source, different: a.target !== b.target }; });
}
