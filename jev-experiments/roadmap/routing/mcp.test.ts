import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy } from "./policy";
const serverPath = join(import.meta.dir, "mcp.ts");
async function exchange(lines: unknown[], env: Record<string, string> = {}) {
  const process = Bun.spawn(["bun", serverPath], {
    env: { ...globalThis.process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const line of lines) process.stdin.write(JSON.stringify(line) + "\n");
  process.stdin.end();
  const stdout = await new Response(process.stdout).text(),
    stderr = await new Response(process.stderr).text(),
    exitCode = await process.exited;
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
test("MCP invalid request does not kill server; tools expose required operations", async () => {
  const replies = await exchange([
    null,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test", version: "1" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
  ]);
  expect(replies.find((r) => r.id === null).error.code).toBe(-32600);
  expect(
    replies.find((r) => r.id === 2).result.tools.map((t: any) => t.name),
  ).toEqual(["decide", "route_task", "classify_eml"]);
  expect(replies.find((r) => r.id === 3).result).toEqual({});
});
test("MCP unsupported task and question return explicit errors without a provider", async () => {
  const replies = await exchange([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "route_task",
        arguments: {
          task: {
            id: "x",
            prompt: "Do a thing",
            context: "",
            requiredTools: ["shell"],
          },
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "decide",
        arguments: {
          request: {
            schemaVersion: "2",
            requestId: "x",
            state: "image",
            questions: [{ id: "q", kind: "image", prompt: "inspect" }],
          },
        },
      },
    },
  ]);
  expect(replies.find((r) => r.id === 1).result.structuredContent.status).toBe(
    "unavailable",
  );
  expect(replies.find((r) => r.id === 2).result.structuredContent.status).toBe(
    "error",
  );
  expect(replies.find((r) => r.id === 2).result.structuredContent.issues[0].code).toBe("invalid_question");
});
test("an unwritable optional audit does not kill MCP discovery or ping", async () => {
  const process = Bun.spawn(["bun", serverPath], {
    env: {
      ...globalThis.process.env,
      JEV_MCP_AUDIT: "/nonexistent/jev-audit/trace.jsonl",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) +
      "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) +
      "\n",
  );
  process.stdin.end();
  const replies = (await new Response(process.stdout).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(replies.find((r) => r.id === 1).result.tools).toHaveLength(3);
  expect(replies.find((r) => r.id === 2).result).toEqual({});
  expect(await new Response(process.stderr).text()).toContain(
    "audit could not be written",
  );
  expect(await process.exited).toBe(0);
});
test("MCP cancellation reaches destination and suppresses late artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-mcp-test-"));
  const http = Bun.serve({
    port: 0,
    async fetch() {
      await Bun.sleep(100);
      return Response.json({
        model: "fixture",
        choices: [
          {
            message: {
              content: JSON.stringify({ kind: "answer", text: "late" }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  try {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        routes: [
          {
            id: "local",
            model: "fixture",
            available: true,
            local: true,
            capabilities: ["text"],
            tools: [],
            contextTokens: 10000,
            maxOutputTokens: 4096,
            quality: { value: 0.5, basis: "simulation", evidence: "fixture" },
            latencyMs: { value: 1, basis: "simulation", evidence: "fixture" },
            pricing: null,
            destination: {
              kind: "openai-compatible",
              endpoint: `http://127.0.0.1:${http.port}`,
            },
          },
        ],
        policy: defaultPolicy,
      }),
    );
    const process = Bun.spawn(["bun", serverPath], {
      env: { ...globalThis.process.env, JEV_ROUTER_CONFIG: path },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    process.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "route_task",
          arguments: {
            task: { id: "cancel", prompt: "bounded task", context: "context" },
          },
        },
      }) + "\n",
    );
    await Bun.sleep(35);
    process.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7 },
      }) + "\n",
    );
    process.stdin.end();
    const output = JSON.parse(
      (await new Response(process.stdout).text()).trim(),
    );
    expect(output.result.structuredContent.status).toBe("cancelled");
    expect(output.result.structuredContent.outcome.artifact).toBeUndefined();
    expect(await process.exited).toBe(0);
  } finally {
    http.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
