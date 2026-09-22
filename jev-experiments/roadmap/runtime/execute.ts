import {
  validateRequest,
  validateResponse,
  requestRejectionStatus,
  type Adapter,
  type DecisionRequest,
  type DecisionResponse,
  type Issue,
} from "./contract";
import {
  accountingIssue,
  requestAccounting,
  type RequestAccounting,
} from "./accounting";
/** A late provider result cannot turn cancellation into success. */
export async function decide(
  adapter: Adapter,
  request: DecisionRequest,
  options: {
    signal?: AbortSignal;
    onAccounting?: (accounting: RequestAccounting) => void;
  } = {},
): Promise<DecisionResponse> {
  const started = performance.now();
  let observed: RequestAccounting | undefined;
  let observedAt = started;
  let finished = false;
  const onAccounting = (accounting: RequestAccounting) => {
    if (finished || accountingIssue(accounting)) return;
    observed = structuredClone(accounting);
    observedAt = performance.now();
    options.onAccounting?.(structuredClone(accounting));
  };
  const requestId =
    typeof request?.requestId === "string" && request.requestId.trim()
      ? request.requestId
      : "invalid-request";
  const failed = (
    status: DecisionResponse["status"],
    issues: Issue[],
  ): DecisionResponse => {
    const accounting =
      observed &&
      requestAccounting(
        observed.attempts.map((attempt) =>
          status === "cancelled" && attempt.status === "pending"
            ? {
                ...attempt,
                status: "cancelled" as const,
                requestMs: attempt.requestMs + performance.now() - observedAt,
                issues: [...attempt.issues, "cancelled"],
              }
            : attempt,
        ),
      );
    const last = accounting?.attempts.at(-1);
    return {
      schemaVersion: "2",
      requestId,
      status,
      decisions: [],
      execution:
        last && adapter.modelResolution === "provider"
          ? {
              ...adapter.identity,
              model: last.model,
              requestedModel: last.requestedModel,
              modelSource: last.modelSource,
            }
          : adapter.identity,
      timing: {
        totalMs: performance.now() - started,
        ...(last ? { requestMs: last.requestMs } : {}),
      },
      issues,
      ...(accounting
        ? { accounting, costUsd: accounting.costUsd, usage: accounting.usage }
        : {}),
    };
  };
  if (options.signal?.aborted)
    return failed("cancelled", [
      { code: "cancelled", message: "The caller cancelled this decision." },
    ]);
  const issues = validateRequest(request, adapter.limits);
  if (issues.length) return failed(requestRejectionStatus(issues), issues);
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<DecisionResponse>((resolve) => {
      if (options.signal) {
        abort = () =>
          resolve(
            failed("cancelled", [
              {
                code: "cancelled",
                message: "The caller cancelled this decision.",
              },
            ]),
          );
        options.signal.addEventListener("abort", abort, { once: true });
      }
    });
    const pending = adapter.decide(request, { ...options, onAccounting });
    const result = await (options.signal
      ? Promise.race([pending, cancelled])
      : pending);
    if (result?.accounting && !options.signal?.aborted)
      onAccounting(result.accounting);
    if (options.signal?.aborted)
      return failed("cancelled", [
        { code: "cancelled", message: "The caller cancelled this decision." },
      ]);
    const errors = validateResponse(request, result);
    if (errors.length) return failed("error", errors);
    if (
      result.execution.adapter !== adapter.identity.adapter ||
      (adapter.modelResolution === "provider"
        ? result.execution.requestedModel !== adapter.identity.model
        : result.execution.model !== adapter.identity.model) ||
      result.execution.local !== adapter.identity.local ||
      (adapter.identity.revision !== undefined &&
        result.execution.revision !== adapter.identity.revision)
    )
      return failed("error", [
        {
          code: "identity_mismatch",
          message:
            "The returned destination does not match the configured runtime.",
        },
      ]);
    return result;
  } catch (e) {
    return failed(options.signal?.aborted ? "cancelled" : "error", [
      {
        code: options.signal?.aborted ? "cancelled" : "runtime_error",
        message: e instanceof Error ? e.message : "Runtime failed.",
      },
    ]);
  } finally {
    finished = true;
    if (abort) options.signal?.removeEventListener("abort", abort);
  }
}
