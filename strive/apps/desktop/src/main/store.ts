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

/** The saved workspace in `dir`, or undefined when none is saved or it doesn't parse. */
export function loadWorkspace(dir: string): History | undefined {
  try {
    const parsed = parseJson(HistorySchema, readFileSync(join(dir, "workspace.json"), "utf8"));

    if (!parsed.ok) return undefined;

    return { ...parsed.value, decided: [...new Set([...parsed.value.decided, ...decisions(dir)])] };
  } catch {
    return undefined; // none saved yet
  }
}

/** Saves `h` in `dir`, keeping decisions other windows saved since this one loaded. */
export function saveWorkspace(dir: string, h: History): void {
  mkdirSync(join(dir, "decided"), { recursive: true });

  // Decisions first: once the layout names one, its file exists.
  for (const key of h.decided) writeFileSync(join(dir, "decided", marker(key)), "", { flag: "a" });
  const file = join(dir, "workspace.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...h, decided: [...new Set([...decisions(dir), ...h.decided])] }));
  renameSync(tmp, file);
}
