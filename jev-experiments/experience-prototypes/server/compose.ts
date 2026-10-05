import { experimental_composeSpec } from "@json-render/core";
import { composeOptions } from "../src/composition-request.js";
import { evaluate, GatewayError } from "../../packages/jev-client/src/index.js";

/**
 * One Jev call a composition made, reported in the stream as it happens so the browser's session
 * meter counts every call on the visitor's key, not just the composition.
 */
export type CallEvent = { type: "call"; ok: boolean; usage?: { input_tokens?: number } | null; latency_ms?: number; served_by?: string | null };

/** The stream's last line when a composition stops early; `status` is the gateway's, when it had one. */
export type ErrorEvent = { type: "error"; error: string; status?: number };

export const COMPOSITION_INTERRUPTED = "Composition interrupted. Check your input and try again.";

export async function* compose(body: any, signal: AbortSignal, apiKey: string) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["prompt", "domain", "strategy", "state", "spec"].includes(key),
    ) ||
    Buffer.byteLength(JSON.stringify(body)) > 100000 ||
    (body.domain !== undefined &&
      !["settings", "apartments", "event"].includes(body.domain)) ||
    (body.strategy !== undefined &&
      !["sequential", "batch"].includes(body.strategy))
  )
    throw new GatewayError("Invalid composition request.", 400);
  if (
    typeof body.prompt !== "string" ||
    !body.prompt.trim() ||
    body.prompt.length > 4000
  )
    throw new GatewayError("Supply a prompt under 4000 characters.", 400);
  // Calls finish inside the composer; their reports go out before the event they led to.
  const calls: CallEvent[] = [];
  try {
    // The options, and the state each request carries, live with the scene's "Build this".
    for await (const event of experimental_composeSpec(
      composeOptions(
        body,
        async ({ state, questions, signal }) => {
          let r;
          try {
            r = await evaluate(
              { state, questions },
              { apiKey, signal, deadlineMs: 22000 },
            );
          } catch (e) {
            // A call the gateway answered with an error still counts; one never sent doesn't.
            if (e instanceof GatewayError && e.attempts.length && e.code !== "cancelled") calls.push({ type: "call", ok: false });
            throw e;
          }
          calls.push({ type: "call", ok: true, usage: r.usage, latency_ms: r.latency_ms, served_by: r.served_by });
          return {
            answers: Object.fromEntries(
              Object.entries(r.answers).map(([k, a]) => [
                k,
                { choice: a.value, confidence: a.confidence ?? undefined },
              ]),
            ),
          };
        },
        signal,
      ),
    )) {
      yield* calls.splice(0);
      yield event;
    }
  } catch (e) {
    // Reported even when the composition stops: the calls were made.
    yield* calls.splice(0);
    throw e;
  }
  yield* calls.splice(0);
}

/**
 * The composition as NDJSON lines, the same from the dev server and the Vercel function: the
 * composer's events, a `call` line per Jev call, and a final `error` line if it stops early.
 */
export async function* composeLines(body: unknown, signal: AbortSignal, apiKey: string): AsyncGenerator<string> {
  try {
    for await (const event of compose(body, signal, apiKey)) yield JSON.stringify(event) + "\n";
  } catch (e) {
    const frame: ErrorEvent =
      e instanceof GatewayError ? { type: "error", error: e.message, status: e.status } : { type: "error", error: COMPOSITION_INTERRUPTED };
    yield JSON.stringify(frame) + "\n";
  }
}
