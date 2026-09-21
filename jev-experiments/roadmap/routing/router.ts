import {
  classifyTask,
  qualityForTask,
  selectRoute,
  validateTask,
  validatePolicy,
  validateRoute,
} from "./policy";
import { executeDestination } from "./execute";
import {
  addCosts,
  classifierIdentity,
  classificationIssues,
  inspectedClassification,
  declaredIdentity,
  executionIssues,
  enforceExecutionIdentity,
  inspectVerification,
} from "./hooks";
import type { Identity } from "../runtime/contract";
import type {
  Classification,
  ClassifierIdentity,
  Executor,
  ExecutionResult,
  Route,
  RouterConfig,
  RoutingResult,
  Task,
  VerificationResult,
} from "./types";

export async function routeTask(
  task: Task,
  config: RouterConfig,
  options: {
    signal?: AbortSignal;
    classifier?: (task: Task, signal?: AbortSignal) => Promise<Classification>;
    classifierMaxCostUsd?: number;
    classifierIdentity?: ClassifierIdentity;
    execute?: Executor;
    verifierIdentity?: Identity;
    verify?: (
      task: Task,
      text: string,
      signal?: AbortSignal,
    ) => Promise<VerificationResult>;
  } = {},
): Promise<RoutingResult> {
  const started = performance.now();
  const declaredClassifier = classifierIdentity(options.classifierIdentity);
  let classification = classifyTask(
    validateTask(task).length
      ? { id: "invalid", prompt: "", context: "" }
      : task,
  );
  if (options.signal?.aborted)
    return {
      schemaVersion: "1",
      taskId: task?.id ?? "invalid",
      status: "cancelled",
      classification,
      selection: {
        status: "unsupported",
        routeId: null,
        candidates: [],
        explanation: "Cancelled before classification.",
        inputTokenUpperBound: 0,
        outputTokens: 0,
      },
      attempts: [],
      outcome: {
        actualRouteId: null,
        actualModel: null,
        totalLatencyMs: performance.now() - started,
        totalCostUsd: 0,
        failure: "Cancelled.",
      },
    };
  if (options.classifier) {
    classification = {
      ...classification,
      source: declaredClassifier?.source ?? "host",
      ...(declaredClassifier ? { declaredExecution: declaredClassifier } : {}),
      status: "not-run",
      costUsd: null,
      evidence: "Custom classifier has not run.",
    };
  }
  const policyIssues = validatePolicy(config?.policy);
  if (policyIssues.length) {
    return {
      schemaVersion: "1",
      taskId: task?.id ?? "invalid",
      status: "unsupported",
      classification,
      selection: {
        status: "unsupported",
        routeId: null,
        candidates: [],
        explanation: policyIssues.join(" "),
        inputTokenUpperBound: 0,
        outputTokens: 0,
      },
      attempts: [],
      outcome: {
        actualRouteId: null,
        actualModel: null,
        totalLatencyMs: performance.now() - started,
        totalCostUsd: 0,
        failure: "Invalid policy; no classifier or destination was called.",
      },
    };
  }
  if (
    options.classifier &&
    config.policy.localOnly &&
    declaredClassifier?.local !== true
  )
    return {
      schemaVersion: "1",
      taskId: task?.id ?? "invalid",
      status: "unavailable",
      classification,
      selection: {
        status: "unavailable",
        routeId: null,
        candidates: [],
        explanation:
          "Local-only policy requires a declared local classifier. No classifier was called.",
        inputTokenUpperBound: 0,
        outputTokens: 0,
      },
      attempts: [],
      outcome: {
        actualRouteId: null,
        actualModel: null,
        totalLatencyMs: performance.now() - started,
        totalCostUsd: 0,
        failure: "Classifier locality does not qualify.",
      },
    };
  if (
    options.classifier &&
    config.policy.maxCostUsd !== undefined &&
    (!Number.isFinite(options.classifierMaxCostUsd) ||
      options.classifierMaxCostUsd! < 0 ||
      options.classifierMaxCostUsd! > config.policy.maxCostUsd)
  ) {
    return {
      schemaVersion: "1",
      taskId: task?.id ?? "invalid",
      status: "unavailable",
      classification,
      selection: {
        status: "unavailable",
        routeId: null,
        candidates: [],
        explanation:
          "A hard spending cap requires a classifier maximum charge reservation within budget. No classifier or destination was called.",
        inputTokenUpperBound: 0,
        outputTokens: 0,
      },
      attempts: [],
      outcome: {
        actualRouteId: null,
        actualModel: null,
        totalLatencyMs: performance.now() - started,
        totalCostUsd: 0,
        failure: "Classifier maximum charge is unknown or exceeds the cap.",
      },
    };
  }
  if (!validateTask(task).length && options.classifier) {
    let classifierFailure = "Classifier invocation failed.";
    try {
      const raw = await options.classifier(task, options.signal);
      // First validate the reported traits on their own, then compare declarations.
      // An honest reported identity is retained when it contradicts the declaration.
      const rawIssues = classificationIssues(raw);
      if (rawIssues.length) {
        classifierFailure = rawIssues.join(" ");
        throw Error(classifierFailure);
      }
      classification = inspectedClassification(raw, declaredClassifier);
      const identityIssues = classificationIssues(
        raw,
        declaredClassifier ?? undefined,
      );
      if (identityIssues.length) {
        classifierFailure = identityIssues.join(" ");
        throw Error(classifierFailure);
      }
    } catch {
      classification = {
        ...classification,
        status: "error",
        latencyMs: performance.now() - started,
        evidence: [classification.evidence, classifierFailure].join(" "),
        costUsd: null,
      };
      return {
        schemaVersion: "1",
        taskId: task.id,
        status: options.signal?.aborted ? "cancelled" : "error",
        classification,
        selection: {
          status: "unsupported",
          routeId: null,
          candidates: [],
          explanation: "Classifier failed. No destination was executed.",
          inputTokenUpperBound: 0,
          outputTokens: 0,
        },
        attempts: [],
        outcome: {
          actualRouteId: null,
          actualModel: null,
          totalLatencyMs: performance.now() - started,
          totalCostUsd: null,
          failure: "Classifier failed.",
        },
      };
    }
  }
  const selection = selectRoute(task, config.routes, config.policy, {
    classification,
  });
  const result: RoutingResult = {
    schemaVersion: "1",
    taskId: task?.id ?? "invalid",
    status: selection.status === "selected" ? "error" : selection.status,
    classification,
    selection,
    attempts: [],
    outcome: {
      actualRouteId: null,
      actualModel: null,
      totalLatencyMs: 0,
      totalCostUsd: classification.costUsd,
    },
  };
  const finish = (status: RoutingResult["status"], failure?: string) => {
    result.status = status;
    result.outcome.totalLatencyMs = performance.now() - started;
    if (failure) {
      if (status === "ok")
        result.outcome.note = [result.outcome.note, failure]
          .filter(Boolean)
          .join(" ");
      else result.outcome.failure = failure;
    }
    return result;
  };
  if (options.signal?.aborted)
    return finish("cancelled", "Cancelled before execution.");
  if (selection.status !== "selected")
    return finish(selection.status, selection.explanation);
  if (config.policy.maxCostUsd !== undefined && classification.costUsd === null)
    return finish(
      "unavailable",
      "A hard spending limit requires known classifier overhead.",
    );
  let spent = classification.costUsd ?? 0,
    selected = selection.routeId!,
    trigger: "initial" | "availability-fallback" | "quality-escalation" =
      "initial";
  for (let i = 0; i < config.policy.maxAttempts; i++) {
    const check = selectRoute(task, config.routes, config.policy, {
      classification,
      excluded: result.attempts.map((a) => a.routeId),
      remainingBudget:
        config.policy.maxCostUsd === undefined
          ? undefined
          : config.policy.maxCostUsd - spent,
    });
    const candidate = check.candidates.find((c) => c.routeId === selected);
    if (!candidate?.eligible)
      return finish(
        "unavailable",
        candidate?.reasons.join(" ") ?? check.explanation,
      );
    const route = config.routes.find((r) => r?.id === selected)!;
    const attemptStarted = performance.now();
    let execution: ExecutionResult;
    try {
      execution = await (options.execute ?? executeDestination)(route, task, {
        signal: options.signal,
        outputTokens: selection.outputTokens,
      });
      const issues = executionIssues(execution);
      if (issues.length)
        execution = {
          status: "malformed",
          actualModel: route.model,
          identityBasis: "configured-unverified",
          usage: null,
          costUsd: null,
          error: `Executor returned invalid metadata: ${issues.join(" ")}`,
        };
      else execution = enforceExecutionIdentity(route.model, execution);
    } catch {
      execution = {
        status: options.signal?.aborted
          ? ("cancelled" as const)
          : ("error" as const),
        actualModel: route.model,
        usage: null,
        costUsd: null,
        error: "Executor failed.",
      };
    }
    const attempt = {
      ...execution,
      routeId: route.id,
      latencyMs: performance.now() - attemptStarted,
      trigger,
      reservedCostUsd: candidate.maximumCostUsd,
    };
    result.attempts.push(attempt);
    // Unknown charges retain the full reservation for all later eligibility checks.
    spent += execution.costUsd ?? candidate.maximumCostUsd ?? 0;
    result.outcome.totalCostUsd = addCosts(
      result.outcome.totalCostUsd,
      execution.costUsd,
    );
    result.outcome.actualModel = execution.actualModel;
    result.outcome.actualRouteId = route.id;
    if (execution.status === "cancelled" || options.signal?.aborted)
      return finish("cancelled", "Cancelled.");
    if (execution.status === "ok" && execution.artifact) {
      result.outcome.artifact = execution.artifact;
      if (execution.artifact.repair)
        result.outcome.note =
          "The model returned malformed hunk counts. One header was deterministically recounted; the original is retained. Host application and tests are still required.";
      if (!config.policy.allowQualityEscalation || !options.verify)
        return finish("ok");
      const identity = declaredIdentity(options.verifierIdentity);
      const skipVerification = (evidence: string) => {
        result.attempts.at(-1)!.verification = {
          status: "skipped",
          identity,
          adequate: null,
          evidence,
          latencyMs: 0,
          costUsd: 0,
        };
        return finish("ok", `${evidence} The returned proposal is unverified.`);
      };
      if (config.policy.localOnly && identity?.local !== true)
        return skipVerification(
          "Quality verification skipped: local-only policy requires an explicitly declared local verifier identity.",
        );
      // No verifier calls with a hard budget unless its maximum cost can be reserved.
      if (config.policy.maxCostUsd !== undefined)
        return skipVerification(
          "Quality verification skipped because no verifier cost bound is configured.",
        );
      const verificationStarted = performance.now();
      const failVerification = (
        status: "error" | "cancelled",
        evidence: string,
        costUsd: number | null,
        issues: string[],
      ) => {
        result.attempts.at(-1)!.verification = {
          status,
          identity,
          adequate: null,
          evidence,
          latencyMs: performance.now() - verificationStarted,
          costUsd,
          issues,
        };
        result.outcome.totalCostUsd = addCosts(
          result.outcome.totalCostUsd,
          costUsd,
        );
        delete result.outcome.artifact;
        return finish(
          status,
          status === "cancelled"
            ? "Cancelled during verification; no quality escalation."
            : `Verifier failed; no quality escalation. ${issues.join(" ")}`,
        );
      };
      try {
        const raw = await options.verify(
          task,
          execution.artifact.text,
          options.signal,
        );
        if (options.signal?.aborted) {
          return failVerification(
            "cancelled",
            "Verifier result discarded after cancellation; its charge is unknown.",
            null,
            ["Cancelled during verification."],
          );
        }
        const inspected = inspectVerification(raw);
        if (!inspected.result)
          return failVerification(
            "error",
            inspected.evidence,
            inspected.costUsd,
            inspected.issues,
          );
        const verification = inspected.result;
        result.attempts.at(-1)!.verification = {
          ...verification,
          status: "ok",
          identity,
        };
        result.outcome.totalCostUsd = addCosts(
          result.outcome.totalCostUsd,
          verification.costUsd,
        );
        if (verification.adequate) return finish("ok");
      } catch {
        if (options.signal?.aborted) {
          return failVerification(
            "cancelled",
            "Verifier was cancelled before returning a valid result; its charge is unknown.",
            null,
            ["Cancelled during verification."],
          );
        }
        return failVerification(
          "error",
          "Verifier threw before returning a valid result; its charge is unknown.",
          null,
          ["Verifier invocation failed."],
        );
      }
      delete result.outcome.artifact;
      const currentTaskQuality = qualityForTask(route, classification);
      const stronger = config.routes.filter((r) => {
        if (validateRoute(r).length) return false;
        const nextTaskQuality = qualityForTask(r, classification);
        return (
          r.quality.basis === "measured" &&
          route.quality.basis === "measured" &&
          r.quality.value > route.quality.value &&
          currentTaskQuality.basis === "measured" &&
          nextTaskQuality.basis === "measured" &&
          nextTaskQuality.value > currentTaskQuality.value
        );
      });
      const next = selectRoute(task, stronger, config.policy, {
        classification,
        excluded: result.attempts.map((a) => a.routeId),
        remainingBudget:
          config.policy.maxCostUsd === undefined
            ? undefined
            : config.policy.maxCostUsd - spent,
      });
      if (!next.routeId)
        return finish(
          "error",
          "Answer failed verification; no eligible destination improves both aggregate and task-calibrated measured quality.",
        );
      selected = next.routeId;
      trigger = "quality-escalation";
      continue;
    }
    if (
      execution.status !== "unavailable" ||
      !config.policy.allowAvailabilityFallback
    )
      return finish(
        "error",
        execution.error ?? "Destination returned no usable artifact.",
      );
    const next = selectRoute(task, config.routes, config.policy, {
      classification,
      excluded: result.attempts.map((a) => a.routeId),
      remainingBudget:
        config.policy.maxCostUsd === undefined
          ? undefined
          : config.policy.maxCostUsd - spent,
    });
    if (!next.routeId) return finish("unavailable", next.explanation);
    selected = next.routeId;
    trigger = "availability-fallback";
  }
  return finish("error", "Attempt limit reached.");
}
