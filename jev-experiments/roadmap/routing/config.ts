import { defaultPolicy, validatePolicy, validateRoute } from "./policy";
import type { RouterConfig } from "./types";
import { localModelIds } from "./mac-adapter";
export async function loadConfig(
  path = process.env.JEV_ROUTER_CONFIG,
): Promise<RouterConfig> {
  if (!path) return { routes: [], policy: defaultPolicy };
  const config = await Bun.file(path).json();
  if (!Array.isArray(config.routes) || !config.policy)
    throw Error("Router config requires routes and policy.");
  if (
    config.localRuntime &&
    (config.decisionEndpoint ||
      typeof config.localRuntime.executable !== "string" ||
      !config.localRuntime.executable ||
      typeof config.localRuntime.dataDirectory !== "string" ||
      !config.localRuntime.dataDirectory ||
      !localModelIds.includes(config.localRuntime.model))
  )
    throw Error(
      "Select one decision runtime: a valid explicit localRuntime or decisionEndpoint.",
    );
  const errors = [
    ...validatePolicy(config.policy),
    ...config.routes.flatMap(validateRoute),
  ];
  if (
    new Set(config.routes.map((r: any) => r.id)).size !== config.routes.length
  )
    errors.push("Duplicate destination ids.");
  if (errors.length) throw Error(errors.join(" "));
  return config;
}
