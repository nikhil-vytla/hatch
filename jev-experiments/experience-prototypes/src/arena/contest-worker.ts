/**
 * Runs a visitor's contestant in its own thread. Network access is removed before their code
 * loads; the page also stops this worker if a run takes longer than its time limit. Practice
 * runs only ever see public phrases.
 */
import { asEntry, runEntry } from "../../../packages/arena/src/contest/one-box";
import type { Policy } from "../../../packages/arena/src/one-box/replay";

type Request = {
  code: string;
  policy: Policy;
  phrases: { id: string; text: string; intent: string; acceptable: string[] }[];
};

for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"])
  Object.defineProperty(globalThis, name, { value: undefined, configurable: false });

self.onmessage = async (event: MessageEvent<Request>) => {
  const { code, policy, phrases } = event.data;
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));

  try {
    const mod: { answer?: Parameters<typeof asEntry>[0] } = await import(/* @vite-ignore */ url);

    if (!(mod.answer instanceof Function)) {
      self.postMessage({ ok: false, error: "Export a function named answer(state, questions)." });

      return;
    }

    self.postMessage({ ok: true, run: runEntry(asEntry(mod.answer), phrases, policy) });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    URL.revokeObjectURL(url);
  }
};
