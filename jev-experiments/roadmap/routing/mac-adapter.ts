import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import models from "../mac/models.json";
import type { Adapter, DecisionResponse } from "../runtime/contract";
export interface MacRuntimeConfig {
  executable: string;
  model: keyof typeof models.models;
  dataDirectory: string;
}
export const localModelIds = Object.keys(models.models);
function invoke(
  config: MacRuntimeConfig,
  command: "decide" | "classify-eml",
  input: string,
  stdin?: string,
  signal?: AbortSignal,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.executable,
      [command, "--model", config.model, "--data", config.dataDirectory, input],
      { signal, maxBuffer: 2_000_000, timeout: 120_000 },
      (error, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            Error(
              signal?.aborted
                ? "Local inference cancelled."
                : error
                  ? "Local runtime failed; no fallback was attempted."
                  : "Local runtime returned invalid JSON.",
            ),
          );
        }
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}
export function createMacAdapter(config: MacRuntimeConfig): Adapter {
  const model = models.models[config.model];
  if (!model) throw Error("Unknown explicitly selected local model.");
  const identity = {
    adapter: "jev-local-mlx",
    model: model.model,
    revision: model.revision,
    local: true,
  };
  return {
    identity,
    limits: {
      maxStateBytes: 65536,
      maxInputBytes: 131072,
      maxQuestions: 32,
      maxOptions: 8,
      maxOrdinalLevels: 8,
      supportedEntryShapes: ["string"],
      supportsBooleanCriteria: false,
      supportsOrdinalLevels: false,
      maxTokens: 768,
      minPromptChars: 1,
      supportedKinds: ["choice", "boolean", "ordinal"],
    },
    async decide(request, { signal } = {}) {
      const started = performance.now();
      const result = (await invoke(
        config,
        "decide",
        "-",
        JSON.stringify(request),
        signal,
      )) as DecisionResponse;
      return {
        ...result,
        timing: { ...result.timing, totalMs: performance.now() - started },
      };
    },
  };
}
export async function classifyMacEml(
  eml: string,
  config: MacRuntimeConfig,
  signal?: AbortSignal,
) {
  if (
    typeof eml !== "string" ||
    new TextEncoder().encode(eml).length > 1024 * 1024
  )
    throw Error("Supply explicit email content under one MiB.");
  const directory = await mkdtemp(join(tmpdir(), "jev-explicit-email-"));
  try {
    const path = join(directory, "explicit.eml");
    await writeFile(path, eml, { mode: 0o600 });
    return await invoke(config, "classify-eml", path, undefined, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
