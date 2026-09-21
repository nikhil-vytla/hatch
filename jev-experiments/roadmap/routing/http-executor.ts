import {
  delegationInstruction,
  parseArtifact,
  artifactResponseFormat,
  providerFailure,
} from "./artifacts";
import type { ExecutionResult, Route, Task } from "./types";
import { enforceExecutionIdentity } from "./hooks";
function pricedUsage(
  route: Route,
  usage: ExecutionResult["usage"],
): number | null {
  const price = route.pricing;
  if (
    !price ||
    price.basis !== "configured" ||
    !usage ||
    ![
      price.inputPerMillion,
      price.outputPerMillion,
      price.cachedInputPerMillion ?? price.inputPerMillion,
    ].every((n) => Number.isFinite(n) && n >= 0)
  )
    return null;
  const cached = usage.cachedInputTokens ?? 0;
  return (
    ((usage.inputTokens - cached) * price.inputPerMillion +
      cached * (price.cachedInputPerMillion ?? price.inputPerMillion) +
      usage.outputTokens * price.outputPerMillion) /
    1e6
  );
}
/** One HTTP implementation shared by CLI/API/web; credentials are per invocation. */
export async function executeHttp(
  route: Route,
  task: Task,
  options: {
    signal?: AbortSignal;
    outputTokens: number;
    credential?: string;
    costAccounting?: "configured" | "unknown";
    fetcher?: typeof fetch;
  },
): Promise<ExecutionResult> {
  const failed = (
    status: ExecutionResult["status"],
    error: string,
  ): ExecutionResult => ({
    status,
    actualModel: route.model,
    identityBasis: "configured-unverified",
    usage: null,
    costUsd: null,
    error,
  });
  if (options.signal?.aborted)
    return failed("cancelled", "Cancelled before execution.");
  if (route.destination.kind !== "openai-compatible")
    return failed("error", "HTTP executor requires an HTTP destination.");
  let endpoint: URL;
  try {
    endpoint = new URL(route.destination.endpoint);
  } catch {
    return failed("error", "Invalid destination URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    endpoint.hostname,
  );
  if (route.local && !loopback)
    return failed("error", "A local route must use a loopback endpoint.");
  if (
    endpoint.username ||
    endpoint.password ||
    (!loopback && endpoint.protocol !== "https:") ||
    (loopback && !["http:", "https:"].includes(endpoint.protocol))
  )
    return failed("error", "Destination URL violates transport restrictions.");
  try {
    const response = await (options.fetcher ?? fetch)(endpoint, {
      method: "POST",
      redirect: "error",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.credential
          ? { Authorization: `Bearer ${options.credential}` }
          : {}),
      },
      body: JSON.stringify({
        model: route.model,
        messages: [
          { role: "system", content: delegationInstruction },
          { role: "user", content: JSON.stringify(task) },
        ],
        max_tokens: options.outputTokens,
        temperature: 0,
        response_format: artifactResponseFormat,
      }),
    });
    if (!response.ok)
      return failed(
        response.status === 429 || response.status >= 500
          ? "unavailable"
          : "error",
        await providerFailure(response, options.credential),
      );
    const raw = await response.text();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return {
        ...failed("malformed", "Destination returned invalid JSON."),
        rawOutput: raw.slice(0, 100_000),
      };
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return {
        ...failed("malformed", "Destination returned a non-object response."),
        rawOutput: raw.slice(0, 100_000),
      };
    const actualModel =
      typeof body.model === "string" ? body.model : route.model;
    const rawUsage = body.usage;
    const usage =
      rawUsage &&
      [rawUsage.prompt_tokens, rawUsage.completion_tokens].every(
        (n) => Number.isFinite(n) && n >= 0,
      )
        ? {
            inputTokens: rawUsage.prompt_tokens,
            outputTokens: rawUsage.completion_tokens,
            cachedInputTokens:
              Number.isFinite(rawUsage.prompt_tokens_details?.cached_tokens) &&
              rawUsage.prompt_tokens_details.cached_tokens >= 0
                ? Math.min(
                    rawUsage.prompt_tokens,
                    rawUsage.prompt_tokens_details.cached_tokens,
                  )
                : 0,
          }
        : null;
    const identity = {
      actualModel,
      identityBasis:
        typeof body.model === "string"
          ? ("provider-reported" as const)
          : ("configured-unverified" as const),
      usage,
      costUsd:
        options.costAccounting === "unknown" || actualModel !== route.model
          ? null
          : pricedUsage(route, usage),
    };
    if (options.signal?.aborted)
      return enforceExecutionIdentity(route.model, {
        ...identity,
        status: "cancelled",
        error: "Cancelled; late result discarded.",
      });
    if (actualModel !== route.model)
      return enforceExecutionIdentity(route.model, {
        ...identity,
        status: "error",
        rawOutput: String(body.choices?.[0]?.message?.content ?? "").slice(
          0,
          100_000,
        ),
      });
    if (body.choices?.[0]?.finish_reason === "length")
      return {
        ...identity,
        status: "error",
        error: "Destination exhausted the output limit.",
      };
    const content = body.choices?.[0]?.message?.content ?? "";
    try {
      return {
        ...identity,
        status: "ok",
        artifact: parseArtifact(content, { normalizeSingleHunkCounts: true }),
      };
    } catch {
      return {
        ...identity,
        status: "malformed",
        error: "Destination returned an invalid typed artifact.",
        rawOutput: String(content).slice(0, 100_000),
      };
    }
  } catch {
    return failed(
      options.signal?.aborted ? "cancelled" : "unavailable",
      options.signal?.aborted ? "Cancelled." : "Destination connection failed.",
    );
  }
}
