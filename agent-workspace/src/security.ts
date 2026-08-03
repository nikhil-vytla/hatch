/**
 * Production guards, following hermes-workspace's security model:
 *  - fail-closed: refuse to bind non-loopback without a password
 *  - cookie-session auth middleware on every /api route when a password is set
 *  - login rate limiting
 *  - path traversal prevention by resolved real path, not string prefix
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export function assertBindAllowed(host: string, password: string | undefined): void {
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !password) {
    throw new Error(
      `refusing to bind ${host} without WORKSPACE_PASSWORD — set it or bind 127.0.0.1`,
    );
  }
}

export class SessionTokens {
  private readonly tokens = new Set<string>();

  issue(): string {
    const t = randomBytes(24).toString("hex");
    this.tokens.add(t);
    return t;
  }

  valid(token: string | undefined): boolean {
    return token !== undefined && this.tokens.has(token);
  }

  revoke(token: string | undefined): void {
    if (token) this.tokens.delete(token);
  }
}

export function passwordsMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class LoginLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const cur = this.attempts.get(key);
    if (!cur || now > cur.resetAt) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.max;
  }
}

export const COOKIE_NAME = "workspace_session";

export function authMiddleware(opts: {
  password: string | undefined;
  tokens: SessionTokens;
  cookieSecure: boolean;
}) {
  return async (c: Context, next: Next) => {
    if (!opts.password) return next();
    const p = new URL(c.req.url).pathname;
    if (p === "/api/login" || p === "/api/health" || !p.startsWith("/api")) {
      return next();
    }
    const cookie = getCookie(c, COOKIE_NAME);
    if (opts.tokens.valid(cookie)) return next();
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
    if (opts.tokens.valid(bearer)) return next();
    return c.json({ error: "unauthorized" }, 401);
  };
}

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure,
    path: "/",
  });
}

/**
 * Resolve `rel` under `root`, then verify the resolved REAL path is still
 * inside root's real path. Blocks ../ tricks and symlink escapes.
 */
export function safeResolve(root: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new PathError("absolute paths not allowed");
  const rootReal = realpathSync(root);
  const target = path.resolve(rootReal, rel);
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
    throw new PathError("path escapes workspace root");
  }
  // If the target exists, its real path must also stay inside (symlink escape).
  try {
    const real = realpathSync(target);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new PathError("symlink escapes workspace root");
    }
    return real;
  } catch (e) {
    if (e instanceof PathError) throw e;
    // Target does not exist yet (e.g. new file): parent must resolve inside.
    const parentReal = realpathSync(path.dirname(target));
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
      throw new PathError("parent escapes workspace root");
    }
    return path.join(parentReal, path.basename(target));
  }
}

export class PathError extends Error {}
