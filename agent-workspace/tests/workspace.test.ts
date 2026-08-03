import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertBindAllowed,
  LoginLimiter,
  passwordsMatch,
  PathError,
  safeResolve,
  SessionTokens,
} from "../src/security.js";
import { WorkspaceStore } from "../src/store.js";
import type { ChatBackend, ChatMessage } from "../src/backend.js";

const tmp = (name: string) => {
  const p = path.join("/tmp", "agent-workspace-test", `${name}_${Date.now()}`);
  mkdirSync(p, { recursive: true });
  return p;
};

describe("fail-closed bind", () => {
  it("allows loopback without password, refuses 0.0.0.0", () => {
    expect(() => assertBindAllowed("127.0.0.1", undefined)).not.toThrow();
    expect(() => assertBindAllowed("0.0.0.0", undefined)).toThrow(/WORKSPACE_PASSWORD/);
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

  it("password compare is exact", () => {
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

describe("path traversal guard", () => {
  it("blocks .., absolute, and symlink escapes; allows inside paths", () => {
    const root = tmp("root");
    writeFileSync(path.join(root, "ok.txt"), "fine");
    mkdirSync(path.join(root, "sub"));
    const outside = tmp("outside");
    writeFileSync(path.join(outside, "secret.txt"), "no");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "sneaky"));

    expect(safeResolve(root, "ok.txt")).toContain("ok.txt");
    expect(safeResolve(root, "sub/../ok.txt")).toContain("ok.txt");
    expect(safeResolve(root, "new-file.txt")).toContain("new-file.txt");
    expect(() => safeResolve(root, "../etc/passwd")).toThrow(PathError);
    expect(() => safeResolve(root, "/etc/passwd")).toThrow(PathError);
    expect(() => safeResolve(root, "sneaky")).toThrow(PathError);
  });
});

describe("workspace store", () => {
  it("persists sessions and messages across store instances", () => {
    const dir = tmp("store");
    const db = path.join(dir, "ws.sqlite");
    const a = new WorkspaceStore(db);
    const meta = a.createSession("chat_1", "hello");
    a.appendMessage(meta.id, "user", "ping");
    a.appendMessage(meta.id, "assistant", "pong");
    a.close();

    const b = new WorkspaceStore(db);
    expect(b.getSession("chat_1")?.messageCount).toBe(2);
    expect(b.messages("chat_1").map((m) => m.role)).toEqual(["user", "assistant"]);
    b.deleteSession("chat_1");
    expect(b.getSession("chat_1")).toBeUndefined();
    b.close();
  });
});

describe("chat backend contract", () => {
  it("fake backend streams and can be swapped in", async () => {
    const fake: ChatBackend = {
      mode: "openai-compat",
      model: "fake",
      async *stream(messages: readonly ChatMessage[]) {
        yield `echo:${messages[messages.length - 1]!.content}`;
      },
    };
    let out = "";
    for await (const d of fake.stream([{ role: "user", content: "hi" }])) out += d;
    expect(out).toBe("echo:hi");
  });
});
