import { describe, expect, test } from "bun:test";
import { describeFailure, failureLine } from "./live-failure";

const NO_KEY = "Connect your AI Gateway key in Settings to run Jev live.";
const err = (status: number, message = "x", response: unknown = {}) => Object.assign(new Error(message), { name: "EvaluationError", status, response });

describe("live failures", () => {
  test("a missing key and a rejected key are different states", () => {
    expect(describeFailure(err(401, NO_KEY), NO_KEY).kind).toBe("no-key");
    expect(describeFailure(err(401, "Vercel AI Gateway rejected this API key."), NO_KEY).kind).toBe("bad-key");
    expect(describeFailure(err(403, "forbidden")).kind).toBe("bad-key");
  });

  test("rate limits carry the server's retry delay, or a sensible default", () => {
    expect(describeFailure(err(429, "slow down", { retry_after_ms: 12000 }))).toMatchObject({ kind: "rate-limited", retryAfterMs: 12000, retryable: true });
    expect(describeFailure(err(429)).retryAfterMs).toBe(8000);
  });

  test("budget errors are recognised by status or wording, and aren't retried", () => {
    expect(describeFailure(err(402)).kind).toBe("budget");
    expect(describeFailure(err(503, "Spend limit reached for this key"))).toMatchObject({ kind: "budget", retryable: false });
  });

  test("server errors are unavailable and retryable", () => {
    expect(describeFailure(err(503, "Jev is temporarily unavailable.", { retry_after_ms: 3000 }))).toMatchObject({ kind: "unavailable", retryAfterMs: 3000, retryable: true });
    expect(describeFailure(err(502)).kind).toBe("unavailable");
  });

  test("network failures read as offline, and aborts as cancelled", () => {
    expect(describeFailure(new TypeError("Failed to fetch")).kind).toBe("offline");
    expect(describeFailure(err(0)).kind).toBe("offline");
    expect(describeFailure(Object.assign(new Error("aborted"), { name: "AbortError" })).kind).toBe("cancelled");
  });

  test("anything else keeps its own message", () => {
    const f = describeFailure(new Error("The gateway dropped intent."));

    expect(f.kind).toBe("error");
    expect(failureLine(f)).toBe("That run didn't complete. The gateway dropped intent.");
  });
});
