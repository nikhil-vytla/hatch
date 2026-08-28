import { describe, expect, it } from "vitest";
import {
  assertBindAllowed,
  LoginLimiter,
  passwordsMatch,
  SessionTokens,
} from "../src/server/security.js";

describe("fail-closed bind", () => {
  it("allows loopback without password, refuses 0.0.0.0", () => {
    expect(() => assertBindAllowed("127.0.0.1", undefined)).not.toThrow();
    expect(() => assertBindAllowed("localhost", undefined)).not.toThrow();
    expect(() => assertBindAllowed("0.0.0.0", undefined)).toThrow(/PASSWORD/i);
    expect(() => assertBindAllowed("0.0.0.0", "secret")).not.toThrow();
  });
});

describe("auth primitives", () => {
  it("tokens issue/validate/revoke", () => {
    const t = new SessionTokens();
    const token = t.issue();
    expect(t.valid(token)).toBe(true);
    expect(t.valid("forged")).toBe(false);
    t.revoke(token);
    expect(t.valid(token)).toBe(false);
  });

  it("password compare is exact and length-safe", () => {
    expect(passwordsMatch("abc", "abc")).toBe(true);
    expect(passwordsMatch("abc", "abd")).toBe(false);
    expect(passwordsMatch("ab", "abc")).toBe(false);
  });

  it("login limiter caps attempts per window", () => {
    const l = new LoginLimiter(3, 1000);
    expect(l.allow("ip", 0)).toBe(true);
    expect(l.allow("ip", 1)).toBe(true);
    expect(l.allow("ip", 2)).toBe(true);
    expect(l.allow("ip", 3)).toBe(false);
    expect(l.allow("ip", 2000)).toBe(true);
  });
});
