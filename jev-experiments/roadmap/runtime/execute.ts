import {
  validateRequest,
  validateResponse,
  type Adapter,
  type DecisionRequest,
  type DecisionResponse,
  type Issue,
} from "./contract";
/** A late provider result cannot turn cancellation into success. */
export async function decide(
  adapter: Adapter,
  request: DecisionRequest,
  options: { signal?: AbortSignal } = {},
): Promise<DecisionResponse> {
  const started = performance.now();
  const requestId =
    typeof request?.requestId === "string" && request.requestId.trim()
      ? request.requestId
      : "invalid-request";
  const failed = (
    status: DecisionResponse["status"],
    issues: Issue[],
  ): DecisionResponse => ({
    schemaVersion: "1",
    requestId,
    status,
    decisions: [],
    execution: adapter.identity,
    timing: { totalMs: performance.now() - started },
    issues,
  });
  if (options.signal?.aborted)
    return failed("cancelled", [
      { code: "cancelled", message: "The caller cancelled this decision." },
    ]);
  const issues = validateRequest(request, adapter.limits);
  if (issues.length) return failed("unsupported", issues);
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
    const pending = adapter.decide(request, options);
    const result = await (options.signal
      ? Promise.race([pending, cancelled])
      : pending);
    if (options.signal?.aborted)
      return failed("cancelled", [
        { code: "cancelled", message: "The caller cancelled this decision." },
      ]);
    const errors = validateResponse(request, result);
    if (errors.length) return failed("error", errors);
    if (
      result.execution.adapter !== adapter.identity.adapter ||
      result.execution.model !== adapter.identity.model ||
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
    if (abort) options.signal?.removeEventListener("abort", abort);
  }
}
