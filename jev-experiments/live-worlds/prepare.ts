import { readFileSync, writeFileSync } from "node:fs";
import { readRecord } from "../experience-prototypes/scripts/records";

// JSONL is the reviewed source. These ignored JSON files are build inputs only.
export function prepareLiveWorlds() {
  const crowd = readRecord(new URL("./crowd/demo.jsonl", import.meta.url));
  writeFileSync(new URL("./crowd/demo.json", import.meta.url), JSON.stringify(crowd) + "\n");
  const manifest = JSON.parse(readFileSync(new URL("./ghost-brush/recording-manifest.json", import.meta.url), "utf8"));
  const events = readFileSync(new URL("./ghost-brush/recording-events.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const rows = events.filter(event => event.event === "completed");
  if (rows.length !== manifest.cases.length || new Set(rows.map(row => row.id)).size !== rows.length)
    throw Error("Ghost Brush examples must contain one retained completion per declared case.");
  writeFileSync(new URL("./ghost-brush/examples.json", import.meta.url), JSON.stringify({ ...manifest, rows }) + "\n");
}

if (import.meta.main) prepareLiveWorlds();
