import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Bind the implementation explanation to the exact source that was audited. */
export function prepareCapabilityAtlas(lab: string, publicDirectory: string) {
  const folder = resolve(lab, "capability-atlas-2026-09-22");
  const atlasText = readFileSync(resolve(folder, "atlas.json"), "utf8");
  const atlas = JSON.parse(atlasText);
  const root = resolve(lab, "..");
  const hashes = new Map<string, string | null>();
  const matches = (evidence: { path: string; sha256: string }) => {
    if (!hashes.has(evidence.path)) {
      try {
        hashes.set(evidence.path, createHash("sha256").update(readFileSync(resolve(root, evidence.path))).digest("hex"));
      } catch {
        hashes.set(evidence.path, null);
      }
    }
    return hashes.get(evidence.path) === evidence.sha256;
  };
  const wiringMatches = atlas.source_bindings.every(matches);
  const records = Object.fromEntries(atlas.records.map((record: { id: string; evidence: { path: string; sha256: string }[] }) => [
    record.id, wiringMatches && record.evidence.every(matches),
  ]));
  const buildId = createHash("sha256").update(JSON.stringify({ atlasText, sources: [...hashes], records })).digest("hex");
  copyFileSync(resolve(folder, "show-me-jev-capabilities.html"), resolve(publicDirectory, "capabilities.html"));
  writeFileSync(resolve(publicDirectory, "capability-build.json"), JSON.stringify({
    buildId, auditDate: atlas.audited_at, records,
  }) + "\n");
}
