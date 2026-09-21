import type { Artifact, Executor, ExecutionResult, Route, Task } from "./types";

import { delegationInstruction, parseArtifact } from "./artifacts";
import { executeHttp } from "./http-executor";
export const executeDestination: Executor = async (route, task, options) => {
  if (options.signal?.aborted)
    return {
      status: "cancelled",
      actualModel: route.model,
      identityBasis: "configured-unverified",
      usage: null,
      costUsd: null,
      error: "Cancelled before execution.",
    };
  if (route.destination.kind === "opencode") {
    if (route.destination.model !== route.model)
      return {
        status: "error",
        actualModel: route.model,
        identityBasis: "configured-unverified",
        usage: null,
        costUsd: null,
        error:
          "OpenCode destination.model must match route.model exactly; no process was started.",
      };
    return executeOpenCode(route, task, options);
  }
  const credential = route.destination.apiKeyEnv
    ? process.env[route.destination.apiKeyEnv]
    : undefined;
  if (route.destination.apiKeyEnv && !credential)
    return {
      status: "unavailable",
      actualModel: route.model,
      identityBasis: "configured-unverified",
      usage: null,
      costUsd: null,
      error: `Missing configured credential environment variable ${route.destination.apiKeyEnv}.`,
    };
  return executeHttp(route, task, { ...options, credential });
};

async function executeOpenCode(
  route: Route,
  task: Task,
  options: { signal?: AbortSignal; outputTokens: number },
): Promise<ExecutionResult> {
  if (route.local)
    return {
      status: "error",
      actualModel: route.model,
      identityBasis: "configured-unverified",
      usage: null,
      costUsd: null,
      error: "OpenCode delegate is not a local inference adapter.",
    };
  // Fixed executable and config. Task text is passed on stdin, never interpolated into a shell.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "jev-delegate-"));
  const config = {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    snapshot: false,
    autoupdate: false,
    permission: { "*": "deny" },
    agent: {
      "jev-delegate": {
        description: "Bounded text-only delegation",
        mode: "primary",
        steps: 4,
        permission: { "*": "deny" },
        prompt: delegationInstruction,
      },
    },
    provider: {
      "amazon-bedrock": {
        models: {
          [route.model.replace(/^amazon-bedrock\//, "")]: {
            limit: {
              context: route.contextTokens,
              output: options.outputTokens,
            },
          },
        },
      },
    },
  };
  const { spawn } = await import("node:child_process");
  const proc = spawn(
    "opencode",
    [
      "run",
      "--dir",
      dir,
      "--pure",
      "--format",
      "json",
      "--agent",
      "jev-delegate",
      "--model",
      route.model,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const read = (stream: NodeJS.ReadableStream) =>
    new Promise<string>((resolve, reject) => {
      let text = "";
      stream.on("data", (chunk) => (text += chunk.toString()));
      stream.on("end", () => resolve(text));
      stream.on("error", reject);
    });
  const stdoutPromise = read(proc.stdout),
    stderrPromise = read(proc.stderr),
    exitPromise = new Promise<number | null>((resolve, reject) => {
      proc.on("close", resolve);
      proc.on("error", reject);
    });
  const abort = () => proc.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  proc.stdin.write(JSON.stringify(task));
  proc.stdin.end();
  try {
    const [stdout, stderr, code] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      exitPromise,
    ]);
    if (options.signal?.aborted)
      return {
        status: "cancelled",
        actualModel: route.model,
        identityBasis: "configured-unverified",
        usage: null,
        costUsd: null,
        error: "Cancelled.",
      };
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.part?.text ?? "")
      .join("\n");
    const error = events.find((e) => e.type === "error");
    if (error || code !== 0) {
      const status = error?.error?.data?.statusCode;
      const unavailable =
        status === 429 ||
        status >= 500 ||
        error?.error?.name === "ConnectionError";
      return {
        status: unavailable ? "unavailable" : "error",
        actualModel: route.model,
        identityBasis: "configured-unverified",
        usage: null,
        costUsd: null,
        error: `OpenCode delegate failed${status ? ` with HTTP ${status}` : ` with exit ${code}`}.`,
      };
    }
    const steps = events.filter((e) => e.type === "step_finish");
    const usage = steps.length
      ? steps.reduce(
          (sum, e) => ({
            inputTokens:
              sum.inputTokens +
              (e.part?.tokens?.input ?? 0) +
              (e.part?.tokens?.cache?.read ?? 0) +
              (e.part?.tokens?.cache?.write ?? 0),
            outputTokens: sum.outputTokens + (e.part?.tokens?.output ?? 0),
            cachedInputTokens:
              sum.cachedInputTokens + (e.part?.tokens?.cache?.read ?? 0),
          }),
          { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        )
      : null;
    try {
      return {
        status: "ok",
        artifact: parseArtifact(text, { normalizeSingleHunkCounts: true }),
        actualModel: route.model,
        identityBasis: "configured-unverified",
        usage,
        costUsd: null,
      };
    } catch {
      return {
        status: "malformed",
        actualModel: route.model,
        identityBasis: "configured-unverified",
        usage,
        costUsd: null,
        error: "OpenCode delegate did not return a valid typed artifact.",
        rawOutput: text.slice(0, 100_000),
      };
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await rm(dir, { recursive: true, force: true });
  }
}
