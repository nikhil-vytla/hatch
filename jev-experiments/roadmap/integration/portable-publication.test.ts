import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { derivePortableRecord, digest } from "./portable-records";
import { buildPortableIndex } from "./portable-index";
import { preparePublicHarnessEvidence } from "../../capability-atlas-2026-09-22/publication-projection";
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "retained-record-test-")), lab = join(root, "lab"), evidence = join(lab, "roadmap/integration/evidence"), folder = join(evidence, "codex");
 mkdirSync(folder, { recursive: true });
 const summary = { harness: "codex", command: ["/usr/bin/codex", "exec"], evidenceGate: { condition: "authored", passed: false }, cliVersion: "fixture", hostModel: { configured: "authored", identityBasis: "fixture only" }, delegationOccurred: false, firstAuditTime: "2026-01-01T00:00:00Z", auditChronologyOrder: 1 };
 const source = JSON.stringify(summary) + "\n", transcript = JSON.stringify({ type: "turn.started" }) + "\n";
 writeFileSync(join(folder, "summary.portable.json"), derivePortableRecord(source, "summary", digest(source), []));
 writeFileSync(join(folder, "stdout.portable.json"), derivePortableRecord(transcript, "transcript", digest(transcript), []));
 writeFileSync(join(folder, "mcp-audit.jsonl"), JSON.stringify({ event: "tools/list", time: "2026-01-01T00:00:00Z" }) + "\n");
 writeFileSync(join(evidence, "index.json"), JSON.stringify({ orderBasis: "Authored fixture", runs: [{ order: 1, run: "codex", harness: "codex", version: summary.cliVersion, hostModel: summary.hostModel, delegationOccurred: false, firstAuditTime: summary.firstAuditTime, gate: summary.evidenceGate, summary: "codex/summary.json", transcript: "codex/stdout.jsonl", audit: "codex/mcp-audit.jsonl" }] }) + "\n");
 return { root, lab, evidence, folder, source };
}
test("active index reads derivatives explicitly while preserving historical gates and publication links", () => {
 const f = fixture();try {
  buildPortableIndex(f.evidence);const indexText = readFileSync(join(f.evidence, "index.json"), "utf8"), index = JSON.parse(indexText);
  expect(index.runs[0].summary).toBe("codex/summary.portable.json");expect(index.runs[0].gate.passed).toBe(false);
  expect(index.runs[0].retainedRecords.summary.originalSha256).toBe(digest(f.source));
  buildPortableIndex(f.evidence);expect(readFileSync(join(f.evidence, "index.json"), "utf8")).toBe(indexText);
  const dest = join(f.root, "public");preparePublicHarnessEvidence(f.lab, dest);
  const publicIndex = JSON.parse(readFileSync(join(dest, "index.json"), "utf8"));
  expect(publicIndex.runs[0].summary).toBe("codex/summary.json");expect(existsSync(join(dest, publicIndex.runs[0].transcript))).toBe(true);
  expect(JSON.parse(readFileSync(join(dest, "codex/summary.json"), "utf8")).command[0]).toBe("/usr/bin/codex");
  expect(JSON.parse(readFileSync(join(dest, "codex/summary.json"), "utf8")).publication_projection.retained_record_derivative.originalSha256).toBe(digest(f.source));
 } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test("ambiguous original trees and forged lineage fail before publishing", () => {
 const f = fixture();try {
  writeFileSync(join(f.folder, "summary.json"), f.source);expect(() => buildPortableIndex(f.evidence)).toThrow("Ambiguous");rmSync(join(f.folder, "summary.json"));
  buildPortableIndex(f.evidence);const index = JSON.parse(readFileSync(join(f.evidence, "index.json"), "utf8"));index.runs[0].retainedRecords.summary.originalSha256 = "0".repeat(64);writeFileSync(join(f.evidence, "index.json"), JSON.stringify(index));
  const dest = join(f.root, "rejected");expect(() => preparePublicHarnessEvidence(f.lab, dest)).toThrow("lineage mismatch");expect(existsSync(join(dest, "index.json"))).toBe(false);
 } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("unreviewed new conditions cannot be silently dropped from an archive rebuild", () => {
 const f = fixture();try {
  mkdirSync(join(f.evidence, "codex-new"));writeFileSync(join(f.evidence, "codex-new/summary.json"), f.source);
  expect(() => buildPortableIndex(f.evidence)).toThrow("Unindexed condition");
 } finally { rmSync(f.root, { recursive: true, force: true }); }
});
