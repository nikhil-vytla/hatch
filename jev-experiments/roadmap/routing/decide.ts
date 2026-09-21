import {
  DEFAULT_LIMITS,
  questionValues,
  validateRequest,
  validateResponse,
  type Adapter,
  type DecisionRequest,
  type DecisionResponse,
} from "../runtime/contract";
import { decide as checkedDecide } from "../runtime/execute";
import type { RouterConfig } from "./types";
export const priorAdapter: Adapter = {
  identity: { adapter: "state-blind-prior", model: "uniform-v1", local: true },
  limits: DEFAULT_LIMITS,
  async decide(request, options = {}) {
    const started = performance.now();
    const issues = validateRequest(request, this.limits);
    return {
      schemaVersion: "1",
      requestId: request?.requestId ?? "invalid",
      status: options.signal?.aborted
        ? "cancelled"
        : issues.length
          ? "unsupported"
          : "ok",
      execution: this.identity,
      timing: { totalMs: performance.now() - started },
      issues: options.signal?.aborted
        ? [{ code: "cancelled", message: "Cancelled before evaluation." }]
        : issues,
      decisions:
        options.signal?.aborted || issues.length
          ? []
          : request.questions.map((q) => {
              const values = questionValues(q);
              return {
                questionId: q.id,
                selected: values[0],
                distribution: values.map((value) => ({
                  value,
                  probability: 1 / values.length,
                })),
              };
            }),
    };
  },
};
export async function decide(
  request: DecisionRequest,
  options: {
    signal?: AbortSignal;
    adapter?: Adapter;
    endpoint?: RouterConfig["decisionEndpoint"];
  } = {},
): Promise<DecisionResponse> {
  const started = performance.now(),
    adapter = options.adapter ?? priorAdapter,
    endpoint = options.endpoint;
  const identity = endpoint
    ? { adapter: "contract-http", model: "configured", local: endpoint.local }
    : adapter.identity;
  const failure = (
    status: "unsupported" | "error" | "cancelled",
    code: string,
    message: string,
  ): DecisionResponse => ({
    schemaVersion: "1",
    requestId: request?.requestId ?? "invalid",
    status,
    decisions: [],
    execution: identity,
    timing: { totalMs: performance.now() - started },
    issues: [{ code, message }],
  });
  const issues = validateRequest(request, adapter.limits);
  if (issues.length)
    return {
      ...failure("unsupported", "invalid_request", "Unsupported request."),
      issues,
    };
  if (options.signal?.aborted)
    return failure("cancelled", "cancelled", "Cancelled before inference.");
  try {
    let response: DecisionResponse;
    if (endpoint) {
      const url = new URL(endpoint.url),
        loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (endpoint.local && !loopback)
        return failure(
          "error",
          "locality",
          "Local decision endpoints must use a loopback address.",
        );
      if (!loopback && url.protocol !== "https:")
        return failure(
          "error",
          "transport",
          "Remote decision endpoints require HTTPS.",
        );
      const key = endpoint.apiKeyEnv
        ? process.env[endpoint.apiKeyEnv]
        : undefined;
      if (endpoint.apiKeyEnv && !key)
        return failure(
          "error",
          "credentials",
          "Configured credential is unavailable.",
        );
      const http = await fetch(url, {
        method: "POST",
        redirect: "error",
        signal: options.signal,
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(request),
      });
      if (!http.ok)
        return failure(
          "error",
          "http",
          `Decision endpoint returned HTTP ${http.status}.`,
        );
      response = (await http.json()) as DecisionResponse;
      if (endpoint.local && !response.execution?.local)
        return failure(
          "error",
          "locality",
          "Local endpoint reported remote execution.",
        );
    } else
      response = await checkedDecide(adapter, request, {
        signal: options.signal,
      });
    if (options.signal?.aborted)
      return failure(
        "cancelled",
        "cancelled",
        "Cancelled; response discarded.",
      );
    const errors = validateResponse(request, response);
    return errors.length
      ? {
          ...failure(
            "error",
            "invalid_response",
            "Adapter returned an invalid response.",
          ),
          issues: errors,
        }
      : response;
  } catch {
    return failure(
      options.signal?.aborted ? "cancelled" : "error",
      options.signal?.aborted ? "cancelled" : "adapter_error",
      options.signal?.aborted ? "Cancelled." : "Decision adapter failed.",
    );
  }
}
