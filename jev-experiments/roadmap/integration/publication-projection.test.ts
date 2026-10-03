import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  normalizeMachinePaths,
  preparePublicHarnessEvidence,
  projectRewardBenchDocument,
  projectTranscriptEvent,
} from "./publication-projection";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const pathOptions = {
  publicFileExists: (path: string) =>
    path === "jev-experiments/roadmap/routing/mcp.ts",
  fixtureFiles: new Set(["sum.ts"]),
};

describe("publication path projection", () => {
  test("removes entire unknown Unix, Windows, UNC and home paths", () => {
    const paths = [
      "/Users/synthetic/hidden-sentinel/project/file.ts",
      "/custom-root/hidden-sentinel/file.ts",
      "C:\\Users\\synthetic\\hidden-sentinel\\file.ts",
      "\\\\synthetic-host\\hidden-sentinel\\file.ts",
      "~/hidden-sentinel/file.ts",
      "file:///home/synthetic/hidden-sentinel/file.ts",
    ];
    for (const path of paths) {
      expect(normalizeMachinePaths(`read ${path} now`)).toBe(
        "read [machine-path] now",
      );
      expect(normalizeMachinePaths(`read '${path}' now`)).toBe(
        "read '[machine-path]' now",
      );
    }
    expect(
      normalizeMachinePaths(
        'read "/Users/synthetic/hidden sentinel/file.ts" now',
      ),
    ).toBe('read "[machine-path]" now');
  });

  test("only preserves grounded repository files or fixture basenames, and leaves URLs/code intact", () => {
    expect(
      normalizeMachinePaths(
        "/checkout/jev-experiments/roadmap/routing/mcp.ts",
        pathOptions,
      ),
    ).toBe("jev-experiments/roadmap/routing/mcp.ts");
    expect(
      normalizeMachinePaths(
        "/checkout/jev-experiments/private-sentinel/file.ts",
        pathOptions,
      ),
    ).toBe("[machine-path]");
    expect(
      normalizeMachinePaths("/tmp/hidden-sentinel/sum.ts", pathOptions),
    ).toBe("sum.ts");
    expect(
      normalizeMachinePaths("/tmp/hidden-sentinel/other.ts", pathOptions),
    ).toBe("[machine-path]");
    const publicText =
      "https://example.com/research/page?view=2 and ./sum.ts; for (let i = 0; i <= n; i++) total += i;";
    expect(normalizeMachinePaths(publicText)).toBe(publicText);
    const newFileDiff =
      "--- /dev/null\n+++ b/sum.ts\n@@ -0,0 +1 @@\n+return 0;\n";
    expect(normalizeMachinePaths(newFileDiff)).toBe(newFileDiff);
  });

  test("normalizes embedded JSON command arguments while retaining valid escaped quoting", () => {
    const input = 'args=[\\"/home/synthetic/hidden-sentinel/file.ts\\"]';
    expect(normalizeMachinePaths(input)).toBe('args=[\\"[machine-path]\\"]');
  });
});

describe("client envelope allowlists", () => {
  test("omits host inventories while retaining Claude prompts, tool correlation, artifacts and token accounting", () => {
    const init = projectTranscriptEvent("claude", {
      type: "system",
      subtype: "init",
      model: "fixture-model",
      claude_code_version: "1",
      plugins: [{ path: "/custom/hidden-sentinel/plugin" }],
      apiKeySource: "unrelated-metadata",
      skills: ["host-inventory"],
    });
    expect(init).toEqual({
      type: "system",
      subtype: "init",
      model: "fixture-model",
      claude_code_version: "1",
    });
    const input = {
      type: "assistant",
      parent_tool_use_id: "call-1",
      wire_ingest_context: "omit-this",
      message: {
        role: "assistant",
        model: "fixture-model",
        diagnostics: "omit-this",
        content: [
          {
            type: "tool_use",
            id: "call-2",
            name: "route_task",
            input: {
              prompt: "Fix the inclusive sum.",
              context: "export const sum = (n) => n;",
              file: "/tmp/hidden-sentinel/sum.ts",
            },
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          inference_geo: "omit-this",
        },
      },
    };
    const snapshot = structuredClone(input);
    const result: any = projectTranscriptEvent("claude", input, pathOptions);
    expect(result.message.content[0]).toEqual({
      type: "tool_use",
      id: "call-2",
      name: "route_task",
      input: {
        prompt: "Fix the inclusive sum.",
        context: "export const sum = (n) => n;",
        file: "sum.ts",
      },
    });
    expect(result.message.usage).toEqual({
      input_tokens: 12,
      output_tokens: 4,
    });
    expect(result.parent_tool_use_id).toBe("call-1");
    expect(JSON.stringify(result)).not.toContain("omit-this");
    expect(input).toEqual(snapshot);
    const artifact = {
      status: "ok",
      artifact: { kind: "answer", text: "The loop excludes the upper bound." },
    };
    const returned: any = projectTranscriptEvent("claude", {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-2",
            content: JSON.stringify(artifact),
          },
        ],
      },
      tool_use_result: {
        content: JSON.stringify(artifact),
        structuredContent: artifact,
        pluginMetadata: "omit-this",
      },
    });
    expect(returned.tool_use_result.structuredContent).toEqual(artifact);
    expect(returned.message.content[0].tool_use_id).toBe("call-2");
    expect(JSON.stringify(returned)).not.toContain("omit-this");
  });

  test("preserves OpenCode and Codex inputs/results while normalizing nested values and path keys", () => {
    const state = {
      status: "completed",
      input: { prompt: "Analyze the sum.", context: "return n;" },
      output: {
        answer: "Wrong for n > 2.",
        files: { "/tmp/hidden-sentinel/sum.ts": "return n;" },
      },
      metadata: { hostPlugin: "omit-this" },
    };
    const event: any = projectTranscriptEvent(
      "opencode",
      {
        type: "tool_use",
        timestamp: 42,
        sessionID: "omit-this",
        part: { type: "tool", tool: "jev_route_task", callID: "call-1", state },
      },
      pathOptions,
    );
    expect(event.part.callID).toBe("call-1");
    expect(event.part.state.input).toEqual(state.input);
    expect(event.part.state.output.files).toEqual({ "sum.ts": "return n;" });
    expect(JSON.stringify(event)).not.toContain("omit-this");
    const codex: any = projectTranscriptEvent("codex", {
      type: "item.completed",
      item: {
        id: "call-2",
        type: "mcp_tool_call",
        server: "jev",
        tool: "route_task",
        arguments: state.input,
        result: { status: "unsupported", reason: "No shell capability." },
        error: null,
        status: "completed",
        hostMetadata: "omit-this",
      },
    });
    expect(codex.item.arguments).toEqual(state.input);
    expect(codex.item.result).toEqual({
      status: "unsupported",
      reason: "No shell capability.",
    });
    expect(JSON.stringify(codex)).not.toContain("omit-this");
  });

  test("unknown event and content shapes stop publication rather than copying unreviewed metadata", () => {
    expect(() =>
      projectTranscriptEvent("codex", {
        type: "new_host_metadata",
        secret: "sentinel",
      }),
    ).toThrow("Unsupported");
    expect(() =>
      projectTranscriptEvent("claude", {
        type: "assistant",
        message: { content: [{ type: "new_block", text: "sentinel" }] },
      }),
    ).toThrow("Unsupported");
  });
});

describe("benchmark publication projection", () => {
  const withheldText = "A synthetic candidate chosen for display withholding.";
  const manifest = [
    { subset: "Synthetic", id: "7", sha256: hash(withheldText) },
  ];
  const fixture = () => ({
    manifest: { benchmark: "synthetic" },
    result: {
      accuracy: 0.5,
      public_omissions: { candidate_texts_omitted: 0 },
      rows: [
        {
          subset: "Synthetic",
          id: 7,
          prompt: "Choose the better response.",
          candidates: [
            {
              text: "A retained response.",
              chosen: true,
              score: 0.8,
              probabilities: [0.2, 0.8],
            },
            {
              text: withheldText,
              chosen: false,
              score: 0.2,
              probabilities: [0.8, 0.2],
            },
          ],
        },
      ],
    },
  });

  test("hash selection survives option reordering and does not change source, labels, scores or existing omission counts", () => {
    const source = fixture();
    source.result.rows[0].candidates.reverse();
    const before = structuredClone(source);
    const projected: any = projectRewardBenchDocument(source, manifest);
    const candidate = projected.result.rows[0].candidates[0];
    expect(candidate.text).toBe(
      "[Candidate text withheld from this publication copy.]",
    );
    expect(candidate.publication_omission.sha256).toBe(manifest[0].sha256);
    expect({
      chosen: candidate.chosen,
      score: candidate.score,
      probabilities: candidate.probabilities,
    }).toEqual({ chosen: false, score: 0.2, probabilities: [0.8, 0.2] });
    expect(projected.result.rows[0].prompt).toBe(source.result.rows[0].prompt);
    expect(projected.result.accuracy).toBe(0.5);
    expect(projected.result.public_omissions).toEqual(
      source.result.public_omissions,
    );
    expect(projected.result.publication_projection.withheldCandidateTexts).toBe(
      1,
    );
    expect(source).toEqual(before);
    expect(projectRewardBenchDocument(projected, manifest)).toEqual(projected);
  });

  test("stale hashes, missing rows and duplicate matches fail closed", () => {
    const changed = fixture();
    changed.result.rows[0].candidates[1].text += " Changed.";
    expect(() => projectRewardBenchDocument(changed, manifest)).toThrow("hash");
    expect(() =>
      projectRewardBenchDocument(fixture(), [{ ...manifest[0], id: "8" }]),
    ).toThrow("row");
    const ambiguous = fixture();
    ambiguous.result.rows[0].candidates.push(
      structuredClone(ambiguous.result.rows[0].candidates[1]),
    );
    expect(() => projectRewardBenchDocument(ambiguous, manifest)).toThrow(
      "ambiguous",
    );
  });
});

test("generated downloads are linked, source-bound, normalized and source-immutable", () => {
  const temporary = mkdtempSync(join(tmpdir(), "jev-publication-synthetic-"));
  try {
    const lab = join(temporary, "jev-experiments");
    const evidence = join(lab, "roadmap/integration/evidence");
    const destination = join(temporary, "public");
    const write = (path: string, value: unknown) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    };
    write(join(evidence, "index.json"), {
      orderBasis: "Chronology",
      runs: [
        {
          run: "codex",
          harness: "codex",
          summary: "codex/summary.json",
          transcript: "codex/stdout.jsonl",
          audit: "codex/mcp-audit.jsonl",
        },
      ],
    });
    write(join(evidence, "codex/summary.json"), {
      harness: "codex",
      directory: "/custom-root/hidden-sentinel/repository",
      command: ["codex", "run"],
      delegationOccurred: true,
      hostMetadata: "omit-this",
    });
    write(
      join(evidence, "codex/stdout.jsonl"),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "call-1",
          type: "command_execution",
          status: "completed",
          command: "cat /custom-root/hidden-sentinel/sum.ts",
          aggregated_output: "return n;",
          exit_code: 0,
        },
      }) + "\n",
    );
    write(
      join(evidence, "codex/mcp-audit.jsonl"),
      JSON.stringify({
        event: "initialize",
        time: "2026-01-01",
        client: { name: "fixture", version: "1", privateMetadata: "omit-this" },
      }) + "\n",
    );
    write(
      join(evidence, "codex/host.diff"),
      "--- a/sum.ts\n+++ b/sum.ts\n@@ -1 +1 @@\n-return n;\n+return n * (n + 1) / 2;\n",
    );
    write(join(evidence, "codex/tests-after.txt"), "1 pass\n");
    const sources = [
      "index.json",
      ...readdirSync(join(evidence, "codex")).map((name) => `codex/${name}`),
    ];
    const before = sources.map((name) =>
      hash(readFileSync(join(evidence, name), "utf8")),
    );
    expect(preparePublicHarnessEvidence(lab, destination)).toEqual({
      runs: 1,
      files: 6,
    });
    const index = JSON.parse(
      readFileSync(join(destination, "index.json"), "utf8"),
    );
    expect(index.publication_projection.sourceSha256).toBe(before[0]);
    expect(index.publication_projection.files).toHaveLength(5);
    for (const file of index.publication_projection.files) {
      const published = readFileSync(join(destination, file.path), "utf8");
      expect(published).not.toContain("hidden-sentinel");
      expect(published).not.toContain("omit-this");
      expect(file.publishedSha256).toBe(hash(published));
      expect(file.sourceSha256).toBe(
        hash(readFileSync(join(evidence, file.path), "utf8")),
      );
    }
    expect(
      sources.map((name) => hash(readFileSync(join(evidence, name), "utf8"))),
    ).toEqual(before);
    expect(() => preparePublicHarnessEvidence(lab, evidence)).toThrow(
      "separate",
    );
    expect(() => preparePublicHarnessEvidence(lab, lab)).toThrow("separate");
    expect(() =>
      preparePublicHarnessEvidence(lab, join(evidence, "nested-output")),
    ).toThrow("separate");
    symlinkSync(evidence, join(temporary, "source-alias"));
    expect(() =>
      preparePublicHarnessEvidence(lab, join(temporary, "source-alias")),
    ).toThrow("separate");
    expect(
      sources.map((name) => hash(readFileSync(join(evidence, name), "utf8"))),
    ).toEqual(before);
    const transcript = readFileSync(
      join(destination, index.runs[0].transcript),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(transcript[0].originalEventCount).toBe(1);
    expect(transcript[1].item.command).toBe("cat sum.ts");
    expect(transcript[1].item.aggregated_output).toBe("return n;");
    rmSync(join(destination, "codex/host.diff"));
    symlinkSync(
      join(evidence, "codex/host.diff"),
      join(destination, "codex/host.diff"),
    );
    expect(() => preparePublicHarnessEvidence(lab, destination)).toThrow(
      "escapes",
    );
    expect(
      sources.map((name) => hash(readFileSync(join(evidence, name), "utf8"))),
    ).toEqual(before);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
