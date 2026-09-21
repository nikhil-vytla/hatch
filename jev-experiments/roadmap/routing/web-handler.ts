import { apiKeyFromHeader } from "../../experience-prototypes/server/gateway";
import { routeTask } from "./router";
import { defaultPolicy, validatePolicy, validateTask } from "./policy";
import { executeHttp } from "./http-executor";
import { webRoutes } from "./web-registry";
import type { Executor } from "./types";
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST")
    return res.status(405).json({ error: "Use POST." });
  const key = apiKeyFromHeader(req.headers?.authorization);
  if (!key)
    return res
      .status(401)
      .json({
        error: "Enter your Vercel AI Gateway API key to execute a route.",
      });
  const body = req.body;
  if (
    !body ||
    Buffer.byteLength(JSON.stringify(body)) > 100_000 ||
    Object.keys(body).some(
      (k) =>
        ![
          "task",
          "weights",
          "allowedRouteIds",
          "maxCostUsd",
          "allowAvailabilityFallback",
        ].includes(k),
    )
  )
    return res
      .status(400)
      .json({ error: "Supply a task and routing preferences under 100 KB." });
  const policy = {
    ...defaultPolicy,
    weights: body.weights ?? defaultPolicy.weights,
    allowedRouteIds: body.allowedRouteIds ?? webRoutes.map((r) => r.id),
    maxCostUsd: body.maxCostUsd ?? 0.05,
    allowAvailabilityFallback: body.allowAvailabilityFallback === true,
    maxAttempts: body.allowAvailabilityFallback === true ? 2 : 1,
  };
  if (
    [...validateTask(body.task), ...validatePolicy(policy)].length ||
    !Array.isArray(policy.allowedRouteIds) ||
    policy.allowedRouteIds.some(
      (id: unknown) =>
        typeof id !== "string" || !webRoutes.some((r) => r.id === id),
    ) ||
    body.task.outputTokens > 4096
  )
    return res
      .status(400)
      .json({
        error:
          "Invalid task or preferences. Use known destinations and at most 4096 output tokens.",
      });
  const execute: Executor = (route, task, options) =>
    executeHttp(route, task, {
      ...options,
      credential: key,
      costAccounting: "unknown",
    });
  try {
    return res
      .status(200)
      .json(
        await routeTask(
          body.task,
          { routes: webRoutes, policy },
          { execute, signal: AbortSignal.timeout(50_000) },
        ),
      );
  } catch {
    return res.status(500).json({ error: "Routing could not complete." });
  }
}
