import type { Classification, Policy, Route, Selection, Task } from "./types";

export const defaultPolicy: Policy = {
  weights: { quality: 0.6, cost: 0.25, latency: 0.15 },
  allowedTools: [],
  allowAvailabilityFallback: false,
  allowQualityEscalation: false,
  maxAttempts: 1,
};
export function classifyTask(task: Task): Classification {
  const text = task.prompt.toLowerCase();
  const category = /\b(test|tests|coverage)\b/.test(text)
    ? "test-writing"
    : /\b(bug|fix|broken|crash)\b/.test(text)
      ? "bug-fix"
      : /\b(repository|repo|architecture|analyse|analyze)\b/.test(text)
        ? "repository-analysis"
        : /\b(write|rewrite|summarize)\b/.test(text)
          ? "writing"
          : "other";
  return {
    source: "heuristic",
    category,
    difficulty: 0.5,
    confidence: 0.5,
    latencyMs: 0,
    costUsd: 0,
    evidence:
      "Version 1 lexical baseline. Scores are uncalibrated; difficulty is a fixed prior.",
  };
}
export function validateTask(task: Task): string[] {
  if (!task || typeof task !== "object") return ["Task must be an object."];
  const errors: string[] = [];
  if (typeof task.id !== "string" || !task.id)
    errors.push("Task id is required.");
  if (typeof task.prompt !== "string" || !task.prompt.trim())
    errors.push("A nonempty prompt is required.");
  if (typeof task.context !== "string")
    errors.push("Context must be an explicit string.");
  if (
    task.outputTokens !== undefined &&
    (!Number.isSafeInteger(task.outputTokens) || task.outputTokens < 1)
  )
    errors.push("outputTokens must be a positive integer.");
  for (const field of ["requiredCapabilities", "requiredTools"] as const)
    if (
      task[field] &&
      (!Array.isArray(task[field]) ||
        task[field].some((x) => typeof x !== "string"))
    )
      errors.push(`${field} must contain strings.`);
  return errors;
}
export function validatePolicy(policy: Policy): string[] {
  const errors: string[] = [];
  if (!policy || typeof policy !== "object") return ["Policy is required."];
  if (
    !policy.weights ||
    ["quality", "cost", "latency"].some(
      (k) =>
        !Number.isFinite(policy.weights[k as keyof Policy["weights"]]) ||
        policy.weights[k as keyof Policy["weights"]] < 0,
    ) ||
    Object.values(policy.weights).reduce((a, b) => a + b, 0) === 0
  )
    errors.push("Weights must be nonnegative, finite and have a positive sum.");
  if (
    !Array.isArray(policy.allowedTools) ||
    policy.allowedTools.some((t) => typeof t !== "string")
  )
    errors.push("allowedTools must be an explicit string array.");
  if (
    policy.allowedRouteIds !== undefined &&
    (!Array.isArray(policy.allowedRouteIds) ||
      policy.allowedRouteIds.some((id) => typeof id !== "string"))
  )
    errors.push("allowedRouteIds must be a string array.");
  if (
    typeof policy.allowAvailabilityFallback !== "boolean" ||
    typeof policy.allowQualityEscalation !== "boolean" ||
    (policy.localOnly !== undefined && typeof policy.localOnly !== "boolean")
  )
    errors.push("Fallback, escalation and locality flags must be booleans.");
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 4
  )
    errors.push("maxAttempts must be between 1 and 4.");
  for (const key of ["maxCostUsd", "maxLatencyMs", "minimumQuality"] as const)
    if (
      policy[key] !== undefined &&
      (!Number.isFinite(policy[key]) || policy[key]! < 0)
    )
      errors.push(`${key} must be finite and nonnegative.`);
  return errors;
}
export function validateRoute(value: unknown): string[] {
  const r = value as Route;
  if (!r || typeof r !== "object") return ["Destination must be an object."];
  const errors: string[] = [];
  if (
    typeof r.id !== "string" ||
    !r.id ||
    typeof r.model !== "string" ||
    !r.model
  )
    errors.push("Destination id and model are required.");
  if (typeof r.available !== "boolean" || typeof r.local !== "boolean")
    errors.push("Availability and locality must be declared.");
  if (
    !Array.isArray(r.capabilities) ||
    r.capabilities.some((c) => typeof c !== "string") ||
    !Array.isArray(r.tools) ||
    r.tools.length
  )
    errors.push(
      "Bounded delegates require declared capabilities and an empty tool list.",
    );
  if (
    !Number.isSafeInteger(r.contextTokens) ||
    r.contextTokens < 1 ||
    !Number.isSafeInteger(r.maxOutputTokens) ||
    r.maxOutputTokens < 1
  )
    errors.push(
      "Destination context and output limits must be positive finite integers.",
    );
  if (
    !r.quality ||
    !["measured", "simulation"].includes(r.quality.basis) ||
    !Number.isFinite(r.quality.value) ||
    r.quality.value < 0 ||
    r.quality.value > 1 ||
    !r.quality.evidence
  )
    errors.push("Quality evidence is invalid.");
  if (
    !r.latencyMs ||
    !["measured", "simulation"].includes(r.latencyMs.basis) ||
    !Number.isFinite(r.latencyMs.value) ||
    r.latencyMs.value < 0 ||
    !r.latencyMs.evidence
  )
    errors.push("Latency evidence is invalid.");
  if (
    r.taskQuality &&
    Object.values(r.taskQuality).some(
      (q) =>
        !q ||
        ![q.easy, q.hard].every(
          (n) => Number.isFinite(n) && n >= 0 && n <= 1,
        ) ||
        !["measured", "simulation"].includes(q.basis) ||
        !q.evidence,
    )
  )
    errors.push("Task quality calibration is invalid.");
  if (
    r.pricing !== null &&
    (!r.pricing ||
      ![
        r.pricing.inputPerMillion,
        r.pricing.outputPerMillion,
        r.pricing.cachedInputPerMillion ?? 0,
      ].every((n) => Number.isFinite(n) && n >= 0) ||
      !["configured", "simulation"].includes(r.pricing.basis) ||
      !r.pricing.evidence)
  )
    errors.push("Price evidence is invalid.");
  if (
    r.cache &&
    (!Number.isFinite(r.cache.tokens) ||
      r.cache.tokens < 0 ||
      !Number.isFinite(r.cache.expiresAt) ||
      !["observed", "simulation"].includes(r.cache.basis))
  )
    errors.push("Cache evidence is invalid.");
  if (r.destination?.kind === "openai-compatible") {
    try {
      const url = new URL(r.destination.endpoint),
        loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        url.username ||
        url.password ||
        (!loopback && url.protocol !== "https:") ||
        (loopback && !["http:", "https:"].includes(url.protocol)) ||
        (r.local && !loopback)
      )
        errors.push(
          "Destination URL violates transport or locality restrictions.",
        );
    } catch {
      errors.push("Destination URL is invalid.");
    }
  } else if (r.destination?.kind === "opencode") {
    if (
      r.local ||
      typeof r.destination.model !== "string" ||
      !r.destination.model
    )
      errors.push("OpenCode is a remote delegate with a configured model.");
    if (r.destination.model !== r.model)
      errors.push("OpenCode destination.model must match route.model exactly.");
  } else errors.push("Unsupported destination adapter.");
  return errors;
}
/** Task calibration is a soft score; minimumQuality remains an aggregate measured floor. */
export function qualityForTask(
  route: Route,
  classification?: Classification,
): Route["quality"] {
  const calibration = classification
    ? route.taskQuality?.[classification.category]
    : undefined;
  return calibration
    ? {
        value:
          calibration.easy +
          (calibration.hard - calibration.easy) * classification!.difficulty,
        basis: calibration.basis,
        evidence: calibration.evidence,
      }
    : route.quality;
}
// UTF-8 bytes conservatively bound text token counts. Include the executor envelope.
export function inputTokenBound(task: Task): number {
  return new TextEncoder().encode(JSON.stringify(task)).length + 2048;
}
export function selectRoute(
  task: Task,
  routes: Route[],
  policy: Policy,
  options: {
    now?: number;
    excluded?: string[];
    remainingBudget?: number;
    classification?: Classification;
  } = {},
): Selection {
  const problems = [...validateTask(task), ...validatePolicy(policy)];
  if (!Array.isArray(routes)) problems.push("Routes must be an array.");
  if (
    options.remainingBudget !== undefined &&
    (typeof options.remainingBudget !== "number" ||
      !Number.isFinite(options.remainingBudget) ||
      options.remainingBudget < 0)
  )
    problems.push("remainingBudget must be finite and nonnegative.");
  const inputTokenUpperBound = problems.length ? 0 : inputTokenBound(task),
    outputTokens = task?.outputTokens ?? 2048;
  if (problems.length)
    return {
      status: "unsupported",
      routeId: null,
      candidates: [],
      explanation: problems.join(" "),
      inputTokenUpperBound,
      outputTokens,
    };
  const budget =
    options.remainingBudget === undefined
      ? policy.maxCostUsd
      : Math.min(
          options.remainingBudget,
          policy.maxCostUsd ?? options.remainingBudget,
        );
  const candidates = routes.map((route) => {
    const invalid = validateRoute(route);
    if (invalid.length)
      return {
        routeId: route?.id ?? "invalid",
        eligible: false,
        reasons: invalid,
        rankScore: null,
        estimatedCostUsd: null,
        maximumCostUsd: null,
        quality: {
          value: 0,
          basis: "simulation" as const,
          evidence: "Invalid destination.",
        },
        latency: {
          value: 0,
          basis: "simulation" as const,
          evidence: "Invalid destination.",
        },
        cacheBasis: "none",
      };
    const reasons: string[] = [];
    if (routes.filter((r) => r?.id === route.id).length !== 1)
      reasons.push("Destination ids must be unique.");
    const quality = qualityForTask(route, options.classification);
    if (!route.available) reasons.push("Destination is unavailable.");
    if (options.excluded?.includes(route.id))
      reasons.push("Destination has already been attempted.");
    if (policy.allowedRouteIds && !policy.allowedRouteIds.includes(route.id))
      reasons.push("Destination is outside the allowed routes.");
    if (policy.localOnly && !route.local)
      reasons.push("Local-only permission excludes this destination.");
    for (const c of task.requiredCapabilities ?? ["text"])
      if (!route.capabilities.includes(c))
        reasons.push(`Missing required capability: ${c}.`);
    for (const tool of task.requiredTools ?? []) {
      if (!policy.allowedTools.includes(tool))
        reasons.push(`Tool is not permitted: ${tool}.`);
      if (!route.tools.includes(tool))
        reasons.push(`Tool is unavailable: ${tool}.`);
    }
    if (
      route.contextTokens <
      inputTokenUpperBound +
        outputTokens +
        (route.destination.kind === "opencode" ? 32768 : 0)
    )
      reasons.push(
        "Context limit cannot fit the complete input and output allowance.",
      );
    if (route.maxOutputTokens < outputTokens)
      reasons.push("Requested output exceeds destination limit.");
    if (
      policy.minimumQuality !== undefined &&
      (route.quality.basis !== "measured" ||
        route.quality.value < policy.minimumQuality)
    )
      reasons.push(
        "Aggregate measured quality does not qualify for the minimum.",
      );
    if (
      policy.maxLatencyMs !== undefined &&
      (route.latencyMs.basis !== "measured" ||
        route.latencyMs.value > policy.maxLatencyMs)
    )
      reasons.push("Measured latency does not qualify for the limit.");
    const price = route.pricing;
    const validPrice =
      price &&
      [
        price.inputPerMillion,
        price.outputPerMillion,
        price.cachedInputPerMillion ?? price.inputPerMillion,
      ].every((p) => Number.isFinite(p) && p >= 0);
    const maximumCostUsd = validPrice
      ? (inputTokenUpperBound *
          Math.max(
            price.inputPerMillion,
            price.cachedInputPerMillion ?? price.inputPerMillion,
          ) +
          outputTokens * price.outputPerMillion) /
        1e6
      : null;
    const cacheTokens =
      route.cache && route.cache.expiresAt > (options.now ?? Date.now())
        ? Math.max(0, Math.min(inputTokenUpperBound, route.cache.tokens))
        : 0;
    const estimatedCostUsd = validPrice
      ? ((inputTokenUpperBound - cacheTokens) * price.inputPerMillion +
          cacheTokens * (price.cachedInputPerMillion ?? price.inputPerMillion) +
          outputTokens * price.outputPerMillion) /
        1e6
      : null;
    if (budget !== undefined && route.destination.kind === "opencode")
      reasons.push(
        "OpenCode cannot enforce a per-call output charge bound; use a metered HTTP destination for hard spending limits.",
      );
    if (
      budget !== undefined &&
      (maximumCostUsd === null || price?.basis !== "configured")
    )
      reasons.push(
        "Hard spending limit requires configured price bounds; simulated or unknown prices do not qualify.",
      );
    else if (budget !== undefined && maximumCostUsd! > budget)
      reasons.push("Worst-case charge exceeds remaining spending limit.");
    if (
      !Number.isFinite(quality.value) ||
      quality.value < 0 ||
      quality.value > 1
    )
      reasons.push("Invalid quality evidence.");
    if (!Number.isFinite(route.latencyMs.value) || route.latencyMs.value < 0)
      reasons.push("Invalid latency evidence.");
    return {
      routeId: route.id,
      eligible: reasons.length === 0,
      reasons,
      rankScore: null as number | null,
      estimatedCostUsd,
      maximumCostUsd,
      quality,
      latency: route.latencyMs,
      cacheBasis: cacheTokens ? route.cache!.basis : "none",
    };
  });
  const eligible = candidates.filter((c) => c.eligible);
  const maxCost = Math.max(
      1e-9,
      ...eligible.map((c) => c.estimatedCostUsd ?? 0),
    ),
    maxLatency = Math.max(1, ...eligible.map((c) => c.latency.value));
  for (const c of eligible)
    c.rankScore =
      policy.weights.quality * c.quality.value -
      policy.weights.cost *
        (c.estimatedCostUsd === null ? 1 : c.estimatedCostUsd / maxCost) -
      (policy.weights.latency * c.latency.value) / maxLatency;
  eligible.sort(
    (a, b) => b.rankScore! - a.rankScore! || a.routeId.localeCompare(b.routeId),
  );
  return {
    status: eligible.length ? "selected" : "unavailable",
    routeId: eligible[0]?.routeId ?? null,
    candidates,
    explanation: eligible.length
      ? "Selected by quality, estimated cost and latency weights among eligible destinations."
      : "No destination meets every restriction. Eligibility was not widened.",
    inputTokenUpperBound,
    outputTokens,
  };
}
