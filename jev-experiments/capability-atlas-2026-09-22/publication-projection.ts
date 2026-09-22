import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

type RecordValue = Record<string, unknown>;
type Harness = "opencode" | "claude" | "codex";
export type PathProjection = {
  /** Only existing, reviewed repository files may be preserved by this callback. */
  publicFileExists?: (repositoryRelativePath: string) => boolean;
  /** Basenames grounded in the fixture's retained files, rather than arbitrary paths. */
  fixtureFiles?: ReadonlySet<string>;
};

const sha256 = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
const object = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an evidence object.");
  return value as RecordValue;
};
const pick = (value: RecordValue, keys: readonly string[]) =>
  Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );

/** These are display projections, not rewritten measurements or credential filtering. */
export function normalizeMachinePaths(
  text: string,
  options: PathProjection = {},
): string {
  const project = (path: string) => {
    const normalized = path.replace(/^file:\/\//i, "").replaceAll("\\", "/");
    // A standard unified-diff marker and shell device, not a machine-specific location.
    if (normalized === "/dev/null") return normalized;
    const marker = "/jev-experiments/";
    const position = normalized.indexOf(marker);
    if (position >= 0) {
      const candidate = normalized.slice(position + 1);
      if (
        !candidate.split("/").some((piece) => piece === "..") &&
        options.publicFileExists?.(candidate)
      )
        return candidate;
    }
    const basename = normalized.split("/").at(-1) ?? "";
    if (options.fixtureFiles?.has(basename)) return basename;
    return "[machine-path]";
  };
  // Match URLs first so their path portions cannot be mistaken for local files.
  // Quoted paths consume spaces; other paths stop at shell/JSON delimiters.
  const paths =
    /https?:\/\/[^\s"'`<>]+|(["'`])((?:file:\/\/\/|[A-Za-z]:[\\/]|~[\\/]|\\\\|\/(?!\/))[^\r\n]*?)\1|(?<![\w:/.])(?:file:\/\/\/|[A-Za-z]:[\\/]|~[\\/]|\\\\|\/(?!\/))[^\s"'`<>|;,)\]}]+/g;
  return text.replace(
    paths,
    (match, quote: string | undefined, quotedPath: string | undefined) => {
      if (/^https?:\/\//i.test(match)) return match;
      if (quote && quotedPath) {
        const escapedEnd = quotedPath.endsWith("\\");
        return `${quote}${project(escapedEnd ? quotedPath.slice(0, -1) : quotedPath)}${escapedEnd ? "\\" : ""}${quote}`;
      }
      // Preserve punctuation attached to paths in prose, and JSON's escaped quote.
      const suffix = match.match(/[.:\\]+$/)?.[0] ?? "";
      return project(suffix ? match.slice(0, -suffix.length) : match) + suffix;
    },
  );
}

function normalize(value: unknown, options: PathProjection): unknown {
  if (typeof value === "string") return normalizeMachinePaths(value, options);
  if (Array.isArray(value))
    return value.map((item) => normalize(item, options));
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, item]) =>
        [
          normalizeMachinePaths(key, options),
          normalize(item, options),
        ] as const,
    );
    if (new Set(entries.map(([key]) => key)).size !== entries.length)
      throw new Error(
        "Projected path keys would collide; publication needs an explicit mapping.",
      );
    return Object.fromEntries(entries);
  }
  return value;
}

// Token and cost accounting may nest, but deployment geography/service metadata is unrelated.
function numericAccounting(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const projected = numericAccounting(item);
      return projected === undefined ? [] : [[key, projected]];
    }),
  );
}

function content(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error("Unsupported transcript content.");
  return value.flatMap((item) => {
    const block = object(item);
    switch (block.type) {
      case "text":
        return [pick(block, ["type", "text"])];
      case "tool_use":
        return [pick(block, ["type", "id", "name", "input"])];
      case "tool_result":
        return [
          {
            ...pick(block, ["type", "tool_use_id", "is_error"]),
            content: content(block.content),
          },
        ];
      case "thinking":
        return [
          {
            type: "publication_omission",
            reason: "Host reasoning and signature omitted.",
          },
        ];
      default:
        throw new Error("Unsupported transcript content type.");
    }
  });
}

/** Allowlist host envelopes; task arguments and returned artifacts remain intact. */
export function projectTranscriptEvent(
  harness: Harness,
  input: unknown,
  options: PathProjection = {},
): RecordValue {
  const event = object(input);
  let output: RecordValue;
  if (harness === "opencode") {
    const part = object(event.part);
    output = pick(event, ["type", "timestamp"]);
    switch (event.type) {
      case "step_start":
        output.part = pick(part, ["type"]);
        break;
      case "text":
        output.part = pick(part, ["type", "text", "time"]);
        break;
      case "tool_use":
        output.part = {
          ...pick(part, ["type", "tool", "callID"]),
          state: pick(object(part.state), [
            "error",
            "input",
            "output",
            "status",
            "time",
            "title",
          ]),
        };
        break;
      case "step_finish":
        output.part = {
          ...pick(part, ["type", "reason", "cost"]),
          tokens: numericAccounting(part.tokens),
        };
        break;
      default:
        throw new Error("Unsupported OpenCode transcript event.");
    }
  } else if (harness === "claude") {
    output = pick(event, [
      "type",
      "subtype",
      "timestamp",
      "parent_tool_use_id",
    ]);
    switch (event.type) {
      case "system":
        Object.assign(
          output,
          pick(event, [
            "claude_code_version",
            "model",
            "permissionMode",
            "estimated_tokens",
            "estimated_tokens_delta",
          ]),
        );
        break;
      case "assistant":
      case "user": {
        const message = object(event.message);
        output.message = {
          ...pick(message, ["role", "model", "stop_reason", "stop_sequence"]),
          content: content(message.content),
        };
        if (message.usage)
          (output.message as RecordValue).usage = numericAccounting(
            message.usage,
          );
        if (event.tool_use_result)
          output.tool_use_result =
            typeof event.tool_use_result === "string"
              ? event.tool_use_result
              : pick(object(event.tool_use_result), [
                  "type",
                  "file",
                  "stdout",
                  "stderr",
                  "interrupted",
                  "isImage",
                  "noOutputExpected",
                  "content",
                  "structuredContent",
                  "filePath",
                  "oldString",
                  "newString",
                  "originalFile",
                  "structuredPatch",
                  "userModified",
                  "replaceAll",
                ]);
        Object.assign(
          output,
          pick(event, ["error", "api_error_code", "is_api_error_message"]),
        );
        break;
      }
      case "result":
        Object.assign(
          output,
          pick(event, [
            "result",
            "errors",
            "is_error",
            "stop_reason",
            "terminal_reason",
            "api_error_code",
            "api_error_status",
            "duration_ms",
            "duration_api_ms",
            "num_turns",
            "total_cost_usd",
            "permission_denials",
            "ttft_ms",
            "ttft_stream_ms",
            "time_to_request_ms",
            "first_content_frame_ms",
          ]),
        );
        output.usage = numericAccounting(event.usage);
        output.modelUsage = numericAccounting(event.modelUsage);
        break;
      default:
        throw new Error("Unsupported Claude transcript event.");
    }
  } else {
    output = pick(event, ["type"]);
    switch (event.type) {
      case "thread.started":
      case "turn.started":
        break;
      case "turn.completed":
        output.usage = numericAccounting(event.usage);
        break;
      case "item.started":
      case "item.completed": {
        const item = object(event.item);
        const common = ["id", "type", "status"];
        const fields: Record<string, string[]> = {
          agent_message: ["text"],
          command_execution: ["aggregated_output", "command", "exit_code"],
          mcp_tool_call: ["arguments", "error", "result", "server", "tool"],
          file_change: ["changes"],
        };
        if (typeof item.type !== "string" || !Object.hasOwn(fields, item.type))
          throw new Error("Unsupported Codex item.");
        output.item = pick(item, [...common, ...fields[item.type]]);
        break;
      }
      default:
        throw new Error("Unsupported Codex transcript event.");
    }
  }
  return normalize(output, options) as RecordValue;
}

const summaryFields = [
  "harness",
  "directory",
  "command",
  "elapsedSeconds",
  "exitCode",
  "timedOut",
  "baselineTestsExitCode",
  "independentTestsExitCode",
  "mcpDiscovered",
  "toolCalls",
  "toolResults",
  "patchedBug",
  "analysisFileWritten",
  "additionalTestsWritten",
  "delegationOccurred",
  "usableDelegatedArtifacts",
  "cliVersion",
  "hostModel",
  "firstAuditTime",
  "evidenceGate",
  "annotationProvenance",
  "auditChronologyOrder",
  "invokedBeforeInterrupt",
  "serverSawCancellation",
  "serverSawDisconnect",
  "cancelledToolResult",
  "lateSuccessApplied",
  "evidenceBoundary",
  "hostExitedBeforeScheduledReply",
  "clientTerminalReason",
  "sourceUnchanged",
  "expectedTestsFail",
  "purpose",
  "mcpConfigUnchanged",
  "routerConfigUnchanged",
  "contextComplete",
  "observedBoundaryStatuses",
  "noDestinationAttempts",
  "boundaryExplanations",
];

function projectAudit(input: unknown, options: PathProjection): unknown {
  const event = object(input);
  if (
    ![
      "initialize",
      "tools/list",
      "tools/call",
      "tools/result",
      "cancelled",
      "client-disconnected",
    ].includes(String(event.event))
  )
    throw new Error("Unsupported MCP audit event.");
  const projected = pick(event, [
    "event",
    "time",
    "requestId",
    "tool",
    "contextBytes",
    "status",
    "artifactKind",
  ]);
  if (event.event === "initialize")
    projected.client = pick(object(event.client), ["name", "version"]);
  return normalize(projected, options);
}

const projectionNotice = {
  version: "jev-public-evidence-v1",
  note: "Publication copy: machine paths are normalized; unrelated host configuration, identifiers, diagnostics and reasoning metadata are omitted. Task messages, tool inputs/results and recorded outcomes are retained. This is not a fresh run or a byte-identical transcript.",
};

function physicalPath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

/** Generate only reviewed evidence shapes; never copy raw transcripts into public assets. */
export function preparePublicHarnessEvidence(lab: string, destination: string) {
  const source = resolve(lab, "roadmap/integration/evidence");
  const sourceReal = realpathSync(source);
  const checkedSource = (name: string) => {
    if (
      !/^[a-z0-9-]+\/(?:summary\.json|stdout\.jsonl|mcp-audit\.jsonl|host\.diff|tests-after\.txt)$/.test(
        name,
      )
    )
      throw new Error("Unlisted evidence path.");
    const path = realpathSync(resolve(source, name));
    if (!path.startsWith(sourceReal + sep))
      throw new Error("Evidence path escapes its source directory.");
    return path;
  };
  const indexText = readFileSync(resolve(source, "index.json"), "utf8");
  const index = object(JSON.parse(indexText));
  if (!Array.isArray(index.runs)) throw new Error("Missing evidence runs.");
  const files: {
    path: string;
    sourceSha256: string;
    publishedSha256: string;
  }[] = [];
  const pending = new Map<string, string>();
  const publish = (name: string, raw: string, result: string) => {
    if (pending.has(name)) throw new Error("Duplicate public evidence path.");
    files.push({
      path: name,
      sourceSha256: sha256(raw),
      publishedSha256: sha256(result),
    });
    pending.set(name, result);
  };
  const labReal = realpathSync(lab);
  for (const value of index.runs) {
    const run = object(value);
    if (!["opencode", "claude", "codex"].includes(String(run.harness)))
      throw new Error("Unsupported evidence harness.");
    if (typeof run.run !== "string" || !/^[a-z0-9-]+$/.test(run.run))
      throw new Error("Invalid evidence run name.");
    const harness = run.harness as Harness;
    const fixtureFiles = new Set(["sum.ts", "sum.test.ts", "ANALYSIS.md"]);
    // Additional test basenames are grounded in the retained host diff, not arbitrary host paths.
    const diffPath = resolve(source, run.run, "host.diff");
    if (existsSync(diffPath))
      for (const line of readFileSync(
        checkedSource(`${run.run}/host.diff`),
        "utf8",
      ).split("\n")) {
        const matched = /^\+\+\+ b\/([A-Za-z0-9_.-]+\.test\.ts)$/.exec(line);
        if (matched) fixtureFiles.add(matched[1]);
      }
    const options: PathProjection = {
      fixtureFiles,
      publicFileExists: (path) => {
        if (!path.startsWith("jev-experiments/")) return false;
        const resolved = resolve(lab, path.slice("jev-experiments/".length));
        if (!existsSync(resolved) || !statSync(resolved).isFile()) return false;
        return realpathSync(resolved).startsWith(labReal + sep);
      },
    };
    for (const [field, filename] of [
      ["summary", "summary.json"],
      ["transcript", "stdout.jsonl"],
      ["audit", "mcp-audit.jsonl"],
    ] as const) {
      const name = `${run.run}/${filename}`;
      if (run[field] !== name)
        throw new Error("Unexpected evidence index link.");
      const raw = readFileSync(checkedSource(name), "utf8");
      const metadata = { ...projectionNotice, sourceSha256: sha256(raw) };
      if (field === "summary") {
        const result = normalize(
          pick(object(JSON.parse(raw)), summaryFields),
          options,
        ) as RecordValue;
        publish(
          name,
          raw,
          JSON.stringify(
            { ...result, publication_projection: metadata },
            null,
            2,
          ) + "\n",
        );
      } else {
        const events = raw
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        const projected = events.map((event) =>
          field === "transcript"
            ? projectTranscriptEvent(harness, event, options)
            : projectAudit(event, options),
        );
        const header = {
          type: "publication_projection",
          ...metadata,
          originalEventCount: events.length,
        };
        publish(
          name,
          raw,
          [header, ...projected]
            .map((event) => JSON.stringify(event))
            .join("\n") + "\n",
        );
      }
    }
    for (const filename of ["host.diff", "tests-after.txt"]) {
      const name = `${run.run}/${filename}`;
      if (!existsSync(resolve(source, name))) continue;
      const raw = readFileSync(checkedSource(name), "utf8");
      publish(name, raw, normalizeMachinePaths(raw, options));
    }
  }
  const publicIndex = normalize(
    pick(index, ["orderBasis", "runs"]),
    {},
  ) as RecordValue;
  publicIndex.publication_projection = {
    ...projectionNotice,
    sourceSha256: sha256(indexText),
    files,
  };
  pending.set("index.json", JSON.stringify(publicIndex, null, 2) + "\n");
  // Finish validation before writing any output. The source directory is never a destination.
  const resolvedDestination = physicalPath(destination);
  if (
    relative(sourceReal, resolvedDestination).split(sep)[0] !== ".." ||
    relative(resolvedDestination, sourceReal).split(sep)[0] !== ".."
  )
    throw new Error("Publication must use a separate output directory.");
  for (const name of pending.keys()) {
    if (
      !physicalPath(resolve(destination, name)).startsWith(
        resolvedDestination + sep,
      )
    )
      throw new Error("Publication output escapes its destination.");
  }
  for (const [name, output] of pending) {
    const path = resolve(destination, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, output);
  }
  return { runs: index.runs.length, files: pending.size };
}

export type WithheldCandidate = { subset: string; id: string; sha256: string };
const withheldCandidates: readonly WithheldCandidate[] = [
  {
    subset: "Safety",
    id: "828",
    sha256: "29bcb708a9b1768d133d90652695c657099849a3e03e0ed439a8e5255ac87519",
  },
  {
    subset: "Safety",
    id: "1151",
    sha256: "2eda19a0a1c80b232b6c5647ec6ed8edd79fad318745b5078e9404a891a9494b",
  },
  {
    subset: "Focus",
    id: "1604",
    sha256: "cc337b8916915eb56bcd3cdc47430f79efc0a1bd802fc9180579c82416f64991",
  },
  {
    subset: "Focus",
    id: "1734",
    sha256: "9b39c32ca0521de3e662ac5cbb75ccd244df3751f7584aee5ec3e7eb2c19be10",
  },
];
const withheldNotice = "[Candidate text withheld from this publication copy.]";

/** Clone the decoded public document. Labels, scores, counts and original JSONL are unchanged. */
export function projectRewardBenchDocument<T>(
  input: T,
  manifest: readonly WithheldCandidate[] = withheldCandidates,
): T {
  const output = structuredClone(input);
  const document = object(output);
  const result = object(document.result);
  if (!Array.isArray(result.rows)) throw new Error("Missing benchmark rows.");
  for (const entry of manifest) {
    const rows = result.rows
      .map(object)
      .filter(
        (row) => row.subset === entry.subset && String(row.id) === entry.id,
      );
    if (rows.length !== 1 || !Array.isArray(rows[0].candidates))
      throw new Error("Expected publication row is missing or ambiguous.");
    const candidates = rows[0].candidates
      .map(object)
      .filter(
        (candidate) =>
          typeof candidate.text === "string" &&
          (sha256(candidate.text) === entry.sha256 ||
            (candidate.text === withheldNotice &&
              candidate.publication_omission &&
              object(candidate.publication_omission).sha256 === entry.sha256)),
      );
    if (candidates.length !== 1)
      throw new Error(
        "Expected publication text hash is missing or ambiguous.",
      );
    candidates[0].text = withheldNotice;
    candidates[0].publication_omission = {
      sha256: entry.sha256,
      reason:
        "Text withheld by publication policy; recorded labels and scores retained.",
    };
  }
  result.publication_projection = {
    version: "jev-public-candidate-text-v1",
    withheldCandidateTexts: manifest.length,
    note: "Additional display-only text withholding. Original source records, row counts, labels, model scores and aggregate metrics are unchanged; this is separate from the benchmark's content-review omissions.",
  };
  return output;
}
