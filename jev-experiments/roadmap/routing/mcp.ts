#!/usr/bin/env bun
/** Dependency-free MCP stdio server. One JSON-RPC object per line; stdout is protocol only. */
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { decide, routeTask, classifyEml } from "./index";
import { createMacAdapter, classifyMacEml } from "./mac-adapter";
import { loadConfig } from "./config";
const objectSchema = { type: "object", additionalProperties: true };
export const toolDefinitions = [
  {
    name: "decide",
    description:
      "Answer typed choice, boolean or ordinal questions about explicitly supplied state. Default is a labeled state-blind uniform baseline, not a trained model. Returns distributions, execution identity, timing and unsupported/error states.",
    inputSchema: {
      type: "object",
      properties: {
        request: {
          ...objectSchema,
          description:
            "Version 1 decision request with requestId, state and questions.",
        },
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
  {
    name: "route_task",
    description:
      "Delegate one bounded bug fix, test-writing, repository-analysis or writing task to an eligible configured model. Include the complete relevant source and requirements in context. Returns an answer, structured result or proposed unified diff; never applies edits or executes tools. Review the artifact, apply it using your own normal permissions and independently test it. No eligible route returns an explanation.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "object",
          properties: {
            id: { type: "string" },
            prompt: { type: "string" },
            context: { type: "string" },
            requiredCapabilities: { type: "array", items: { type: "string" } },
            requiredTools: { type: "array", items: { type: "string" } },
            outputTokens: { type: "integer", minimum: 1 },
          },
          required: ["id", "prompt", "context"],
          additionalProperties: false,
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "classify_eml",
    description:
      "Classify an explicitly supplied raw .eml message locally. The default is an uncalibrated lexical baseline; an explicitly configured localRuntime uses its installed experimental model. Labels action, receipt, newsletter or other with uncertainty. Does not access or modify a mailbox. The baseline rejects MIME attachments and encoded messages; the configured Mac runtime declares its own coverage.",
    inputSchema: {
      type: "object",
      properties: {
        eml: {
          type: "string",
          description:
            "The complete raw .eml content, read only from a file explicitly supplied by the user.",
        },
      },
      required: ["eml"],
      additionalProperties: false,
    },
  },
];
const config = await loadConfig();
const pending = new Map<string | number, AbortController>();
const audit = (value: unknown) => {
  if (process.env.JEV_MCP_AUDIT)
    try {
      appendFileSync(
        process.env.JEV_MCP_AUDIT,
        JSON.stringify({
          time: new Date().toISOString(),
          ...(value as object),
        }) + "\n",
      );
    } catch {
      process.stderr.write(
        "Jev MCP audit could not be written; tool execution continues.\n",
      );
    }
};
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
async function handle(message: any) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
    return;
  }
  const { id, method, params } = message;
  if (method === "notifications/cancelled") {
    pending.get(params?.requestId)?.abort();
    audit({ event: "cancelled", requestId: params?.requestId });
    return;
  }
  if (id === undefined) return;
  const fail = (code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });
  if (message.jsonrpc !== "2.0" || !["number", "string"].includes(typeof id))
    return fail(-32600, "Invalid request");
  if (method === "initialize") {
    audit({ event: "initialize", client: params?.clientInfo });
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(
          params?.protocolVersion,
        )
          ? params.protocolVersion
          : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "jev-model-routing-lab", version: "0.1.0" },
        instructions:
          "Use route_task for bounded delegation with complete context. It returns proposed artifacts; you retain control of tools and applying changes. Default decide and classify_eml are explicitly labeled baselines.",
      },
    });
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") {
    audit({ event: "tools/list" });
    return send({ jsonrpc: "2.0", id, result: { tools: toolDefinitions } });
  }
  if (method !== "tools/call") return fail(-32601, "Method not found");
  if (!toolDefinitions.some((t) => t.name === params?.name))
    return fail(-32602, "Unknown tool");
  const controller = new AbortController();
  pending.set(id, controller);
  audit({
    event: "tools/call",
    tool: params.name,
    requestId: id,
    contextBytes:
      typeof params.arguments?.task?.context === "string"
        ? new TextEncoder().encode(params.arguments.task.context).length
        : null,
  });
  try {
    const args = params.arguments ?? {};
    const result =
      params.name === "decide"
        ? await decide(args.request, {
            signal: controller.signal,
            endpoint: config.decisionEndpoint,
            adapter: config.localRuntime
              ? createMacAdapter(config.localRuntime)
              : undefined,
          })
        : params.name === "route_task"
          ? await routeTask(args.task, config, { signal: controller.signal })
          : config.localRuntime
            ? await classifyMacEml(
                args.eml,
                config.localRuntime,
                controller.signal,
              )
            : classifyEml(args.eml);
    audit({
      event: "tools/result",
      tool: params.name,
      requestId: id,
      status: result.status,
      artifactKind:
        "outcome" in result ? result.outcome.artifact?.kind : undefined,
    });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: result.status !== "ok",
      },
    });
  } catch {
    audit({ event: "tools/error", tool: params.name, requestId: id });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: "Tool execution failed.",
            }),
          },
        ],
        isError: true,
      },
    });
  } finally {
    pending.delete(id);
  }
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (Buffer.byteLength(line) > 2_000_000) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Request exceeds 2 MB transport limit." },
    });
    continue;
  }
  try {
    void handle(JSON.parse(line)).catch(() =>
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Request handling failed." },
      }),
    );
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON" },
    });
  }
}
// EOF means the owning client has disconnected. Stop outstanding delegates.
for (const [requestId, controller] of pending) {
  audit({ event: "client-disconnected", requestId });
  controller.abort();
}
