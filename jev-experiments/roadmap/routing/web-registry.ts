import type { Route, Task } from "./types";
export const gatewayEndpoint =
  "https://ai-gateway.vercel.sh/v1/chat/completions";
export const webRoutes: Route[] = [
  {
    id: "gpt-4.1-mini",
    model: "openai/gpt-4.1-mini",
    taskQuality: {
      "bug-fix": {
        easy: 0.8,
        hard: 0.5,
        basis: "simulation",
        evidence:
          "Illustrative difficulty interpolation, not measured accuracy.",
      },
      writing: {
        easy: 0.85,
        hard: 0.6,
        basis: "simulation",
        evidence:
          "Illustrative difficulty interpolation, not measured accuracy.",
      },
    },
    available: true,
    local: false,
    capabilities: ["text", "coding"],
    tools: [],
    contextTokens: 1_047_576,
    maxOutputTokens: 32768,
    quality: {
      value: 0.65,
      basis: "simulation",
      evidence:
        "Editable illustrative prior; no comparative accuracy measured.",
    },
    latencyMs: {
      value: 1600,
      basis: "simulation",
      evidence: "Illustrative latency, not a measurement.",
    },
    pricing: {
      inputPerMillion: 0.4,
      outputPerMillion: 1.6,
      cachedInputPerMillion: 0.1,
      basis: "configured",
      evidence:
        "Vercel AI Gateway /v1/models retrieved 2026-09-20; list-price arithmetic, not invoice charges.",
    },
    destination: { kind: "openai-compatible", endpoint: gatewayEndpoint },
  },
  {
    id: "claude-haiku-4.5",
    model: "anthropic/claude-haiku-4.5",
    taskQuality: {
      "bug-fix": {
        easy: 0.9,
        hard: 0.7,
        basis: "simulation",
        evidence:
          "Illustrative difficulty interpolation, not measured accuracy.",
      },
      writing: {
        easy: 0.9,
        hard: 0.75,
        basis: "simulation",
        evidence:
          "Illustrative difficulty interpolation, not measured accuracy.",
      },
    },
    available: true,
    local: false,
    capabilities: ["text", "coding"],
    tools: [],
    contextTokens: 200000,
    maxOutputTokens: 64000,
    quality: {
      value: 0.8,
      basis: "simulation",
      evidence:
        "Editable illustrative prior; no comparative accuracy measured.",
    },
    latencyMs: {
      value: 2400,
      basis: "simulation",
      evidence: "Illustrative latency, not a measurement.",
    },
    pricing: {
      inputPerMillion: 1,
      outputPerMillion: 5,
      cachedInputPerMillion: 0.1,
      basis: "configured",
      evidence:
        "Vercel AI Gateway /v1/models retrieved 2026-09-20; list-price arithmetic, not invoice charges.",
    },
    destination: { kind: "openai-compatible", endpoint: gatewayEndpoint },
  },
];
export const defaultWebTask: Task = {
  id: "routing-demo",
  prompt:
    "Fix the bug. totalThrough(n) must sum every integer from 1 through n inclusive. Return a proposed unified diff for sum.ts.",
  context:
    "sum.ts:\nexport function totalThrough(n: number): number {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n",
  requiredCapabilities: ["text", "coding"],
  outputTokens: 2048,
};
