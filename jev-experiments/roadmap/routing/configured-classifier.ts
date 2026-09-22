import { createJevAdapter } from "../runtime/jev";
import { createDecisionClassifier, DecisionClassifierError } from "./classifier";
import { createMacAdapter } from "./mac-adapter";
import { routeTask } from "./router";
import type { RouterConfig, Task } from "./types";

/** A configured task classifier is separate from the public decide operation. */
export function classifierConfigIssues(config: RouterConfig): string[] {
  const value = config.classifier;
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return ["classifier must name an explicit supported kind."];
  if (!["heuristic", "hosted-jev", "local"].includes(value.kind))
    return ["classifier.kind must be heuristic, hosted-jev or local."];
  const allowed = value.kind === "hosted-jev" ? ["kind", "apiKeyEnv"] : ["kind"];
  if (Object.keys(value).some(key => !allowed.includes(key)))
    return ["Unsupported classifier configuration field."];
  if (value.kind === "hosted-jev" &&
    (typeof value.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv)))
    return ["hosted-jev classifier requires an explicit credential environment name."];
  if (value.kind === "local" && !config.localRuntime)
    return ["local classifier requires an explicit localRuntime model and installation."];
  return [];
}

export function configuredClassifierInfo(config: RouterConfig) {
  const kind = config.classifier?.kind ?? "heuristic";
  return {
    kind,
    description: kind === "hosted-jev"
      ? "Hosted Jev; shared version 2 category and expected difficulty"
      : kind === "local"
        ? `Explicit local model ${config.localRuntime?.model}; shared version 2 category and expected difficulty`
        : "Lexical heuristic; no model classification",
  };
}

/** One selection/execution implementation for CLI, MCP and configured SDK calls. */
export function routeConfiguredTask(
  task: Task,
  config: RouterConfig,
  options: { signal?: AbortSignal } = {},
) {
  const issues = classifierConfigIssues(config);
  if (issues.length) throw Error(issues.join(" "));
  if (config.classifier?.kind === "local") {
    const classifier = createDecisionClassifier(createMacAdapter(config.localRuntime!));
    return routeTask(task, config, { ...classifier, ...options });
  }
  if (config.classifier?.kind === "hosted-jev") {
    const key = process.env[config.classifier.apiKeyEnv];
    const adapter = createJevAdapter(key ?? "", undefined, { maxAttempts: 1 });
    const classifier = createDecisionClassifier(adapter);
    return routeTask(task, config, {
      ...classifier,
      ...options,
      classifier: async (input, signal) => {
        if (!key) throw new DecisionClassifierError({
          schemaVersion: "2",
          requestId: `${input.id}-classification`,
          status: "error",
          decisions: [],
          execution: { ...adapter.identity, modelSource: "configured-unverified" },
          timing: { totalMs: 0 },
          costUsd: 0,
          issues: [{ code: "credentials", message: "Configured classifier credential is unavailable; no request was made." }],
        }, "hosted");
        return classifier.classifier(input, signal);
      },
    });
  }
  return routeTask(task, config, options);
}
