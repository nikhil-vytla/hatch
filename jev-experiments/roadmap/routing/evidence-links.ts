import routingProtocol from "./PROTOCOL.md?url&no-inline";
import comparisonProtocol from "./comparison/PROTOCOL.md?url&no-inline";
import comparisonReport from "./comparison/report.json?url&no-inline";
import comparisonReadme from "./comparison/README.md?url&no-inline";
import failureProtocol from "../integration/FAILURE-PROTOCOL.md?url&no-inline";

// Build-only publication copies preserve the retained task evidence without
// bundling raw host transcripts. Their index records source and output hashes.
const evidenceUrl = (path: string) => `/routing-evidence/${path}`;

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
    url: evidenceUrl("index.json"),
    file: "jev-client-evidence-index.json",
  },
];
export const harnessDownloads = [
  {
    name: "OpenCode",
    id: "opencode",
    summary: evidenceUrl("opencode/summary.json"),
    audit: evidenceUrl("opencode/mcp-audit.jsonl"),
    transcript: evidenceUrl("opencode/stdout.jsonl"),
    diff: evidenceUrl("opencode/host.diff"),
    tests: evidenceUrl("opencode/tests-after.txt"),
  },
  {
    name: "Claude Code",
    id: "claude",
    summary: evidenceUrl("claude/summary.json"),
    audit: evidenceUrl("claude/mcp-audit.jsonl"),
    transcript: evidenceUrl("claude/stdout.jsonl"),
    diff: evidenceUrl("claude/host.diff"),
    tests: evidenceUrl("claude/tests-after.txt"),
  },
  {
    name: "Codex",
    id: "codex",
    summary: evidenceUrl("codex/summary.json"),
    audit: evidenceUrl("codex/mcp-audit.jsonl"),
    transcript: evidenceUrl("codex/stdout.jsonl"),
    diff: evidenceUrl("codex/host.diff"),
    tests: evidenceUrl("codex/tests-after.txt"),
  },
];
