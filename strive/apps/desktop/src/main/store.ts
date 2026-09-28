// The workspace a window saves. Several windows, each maybe in its own app
// process, save the same file, and the layout is the last saver's. Decisions
// on the agent's proposals must never be lost that way, so each one is also a
// file of its own in `decided/`: created once, never rewritten or removed, so
// no interleaving of saves can undo one.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type History, HistorySchema, parseJson } from "@strive/workspace";

/** A decision's file name: proposal keys may hold any character. */
const marker = (key: string) => Buffer.from(key).toString("base64url");

function decisions(dir: string): string[] {
  try {
    return readdirSync(join(dir, "decided")).map((name) => Buffer.from(name, "base64url").toString());
  } catch {
    return []; // none made yet
  }
}

function loadLayout(file: string): History | undefined {
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined; // none saved yet
  }

  const parsed = parseJson(HistorySchema, text);

  return parsed.ok ? parsed.value : undefined;
}

/** The saved workspace in `dir`, or undefined when none is saved or it doesn't parse. */
export function loadWorkspace(dir: string): History | undefined {
  const saved = loadLayout(join(dir, "workspace.json"));

  return saved && { ...saved, decided: [...new Set([...saved.decided, ...decisions(dir)])] };
}

/** Makes a file for each decision, where there isn't one. */
function mark(dir: string, keys: readonly string[]): void {
  mkdirSync(join(dir, "decided"), { recursive: true });

  for (const key of keys) writeFileSync(join(dir, "decided", marker(key)), "", { flag: "a" });
}

/**
 * Saves `h` in `dir`, keeping decisions other windows saved since this one
 * loaded. The layout goes first: a save that fails before it lands decides
 * nothing, so an accepted proposal whose edit wasn't saved is offered again.
 * A save that failed after it left decisions only in the layout, so each
 * save first gives the layout's decisions files before replacing it.
 */
export function saveWorkspace(dir: string, h: History): void {
  const file = join(dir, "workspace.json");

  const onDisk = loadLayout(file);

  // Unguarded: if this fails, the layout must not be replaced.
  if (onDisk) mark(dir, onDisk.decided);

  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...h, decided: [...new Set([...decisions(dir), ...h.decided])] }));
  renameSync(tmp, file);
  mark(dir, h.decided);
}
