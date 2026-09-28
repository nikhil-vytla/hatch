/**
 * Runs a visitor's contestant inside QuickJS (a JavaScript interpreter compiled to WebAssembly):
 * no network, no filesystem, no host objects, a memory cap, and an interrupt deadline on every
 * call. Used by the server for sealed scoring, where the phrases must never reach the entry's
 * author; the browser's practice runs use a Web Worker instead.
 */
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { QUESTIONS } from "../one-box/questions";
import { asEntry, type Entry } from "./one-box";

/** A call that runs this long is stopped outright (the scoring budget is far lower). */
const HARD_LIMIT_MS = 250;

/** After this many stopped calls the entry is not called again, so a stuck entry can't hold a server. */
const MAX_STRIKES = 3;

const MEMORY_BYTES = 64 * 1024 * 1024;

/** `export function answer` becomes a plain function the host can find. */
const toScript = (code: string) =>
  `${code.replace(/\bexport\s+(?=(async\s+)?function\b|const\b|let\b|var\b|class\b)/g, "")}
;globalThis.__call = (state, questions) =>
  JSON.stringify(answer(JSON.parse(state), JSON.parse(questions)) ?? null);`;

export async function sandboxEntry(code: string): Promise<{ entry: Entry; dispose: () => void }> {
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();

  runtime.setMemoryLimit(MEMORY_BYTES);
  runtime.setMaxStackSize(1024 * 1024);
  const vm = runtime.newContext();

  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 2000));
  const loaded = vm.evalCode(toScript(code), "contestant.js");

  if (loaded.error) {
    const message = JSON.stringify(vm.dump(loaded.error));

    loaded.error.dispose();
    vm.dispose();
    runtime.dispose();
    throw new Error(`Your code did not load: ${message}`);
  }

  loaded.value.dispose();
  const call = vm.getProp(vm.global, "__call");
  const questions = vm.newString(JSON.stringify(QUESTIONS));

  let strikes = 0;

  const entry = asEntry((state) => {
    if (strikes >= MAX_STRIKES)
      throw new Error(`Stopped: answer() ran past ${HARD_LIMIT_MS} ms ${MAX_STRIKES} times.`);

    const started = Date.now();

    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + HARD_LIMIT_MS));
    const text = vm.newString(JSON.stringify(state));
    const result = vm.callFunction(call, vm.undefined, text, questions);

    text.dispose();

    if (result.error) {
      const message = JSON.stringify(vm.dump(result.error));

      result.error.dispose();

      if (Date.now() - started >= HARD_LIMIT_MS) strikes++;
      throw new Error(message);
    }

    const json = vm.getString(result.value);

    result.value.dispose();

    return JSON.parse(json);
  });

  const dispose = () => {
    questions.dispose();
    call.dispose();
    vm.dispose();
    runtime.dispose();
  };

  return { entry, dispose };
}
