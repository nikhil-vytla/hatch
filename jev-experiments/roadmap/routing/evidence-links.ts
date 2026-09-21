import routingProtocol from "./PROTOCOL.md?url&no-inline";
import comparisonProtocol from "./comparison/PROTOCOL.md?url&no-inline";
import comparisonReport from "./comparison/report.json?url&no-inline";
import comparisonReadme from "./comparison/README.md?url&no-inline";
import failureProtocol from "../integration/FAILURE-PROTOCOL.md?url&no-inline";
import evidenceIndex from "../integration/evidence/index.json?url&no-inline";
import opencodeSummary from "../integration/evidence/opencode/summary.json?url&no-inline";
import opencodeAudit from "../integration/evidence/opencode/mcp-audit.jsonl?url&no-inline";
import opencodeTranscript from "../integration/evidence/opencode/stdout.jsonl?url&no-inline";
import opencodeDiff from "../integration/evidence/opencode/host.diff?url&no-inline";
import opencodeTests from "../integration/evidence/opencode/tests-after.txt?url&no-inline";
import claudeSummary from "../integration/evidence/claude/summary.json?url&no-inline";
import claudeAudit from "../integration/evidence/claude/mcp-audit.jsonl?url&no-inline";
import claudeTranscript from "../integration/evidence/claude/stdout.jsonl?url&no-inline";
import claudeDiff from "../integration/evidence/claude/host.diff?url&no-inline";
import claudeTests from "../integration/evidence/claude/tests-after.txt?url&no-inline";
import codexSummary from "../integration/evidence/codex/summary.json?url&no-inline";
import codexAudit from "../integration/evidence/codex/mcp-audit.jsonl?url&no-inline";
import codexTranscript from "../integration/evidence/codex/stdout.jsonl?url&no-inline";
import codexDiff from "../integration/evidence/codex/host.diff?url&no-inline";
import codexTests from "../integration/evidence/codex/tests-after.txt?url&no-inline";

export const protocolDownloads = [
  {
    label: "Routing protocol",
    url: routingProtocol,
    file: "jev-routing-protocol.md",
  },
  {
    label: "Comparison protocol",
    url: comparisonProtocol,
    file: "jev-comparison-protocol.md",
  },
  {
    label: "Comparison report",
    url: comparisonReadme,
    file: "jev-comparison-report.md",
  },
  {
    label: "Comparison results (JSON)",
    url: comparisonReport,
    file: "jev-comparison-results.json",
  },
  {
    label: "Client failure protocol",
    url: failureProtocol,
    file: "jev-client-failure-protocol.md",
  },
  {
    label: "Client evidence index",
    url: evidenceIndex,
    file: "jev-client-evidence-index.json",
  },
];
export const harnessDownloads = [
  {
    name: "OpenCode",
    id: "opencode",
    summary: opencodeSummary,
    audit: opencodeAudit,
    transcript: opencodeTranscript,
    diff: opencodeDiff,
    tests: opencodeTests,
  },
  {
    name: "Claude Code",
    id: "claude",
    summary: claudeSummary,
    audit: claudeAudit,
    transcript: claudeTranscript,
    diff: claudeDiff,
    tests: claudeTests,
  },
  {
    name: "Codex",
    id: "codex",
    summary: codexSummary,
    audit: codexAudit,
    transcript: codexTranscript,
    diff: codexDiff,
    tests: codexTests,
  },
];
