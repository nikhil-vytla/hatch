import type { RequestAccounting } from "../runtime/accounting";
import type { DecisionResponse, Issue } from "../runtime/contract";
export type TaskCategory =
  "bug-fix" | "test-writing" | "repository-analysis" | "writing" | "other";
export interface Task {
  id: string;
  prompt: string;
  context: string;
  requiredCapabilities?: string[];
  requiredTools?: string[];
  outputTokens?: number;
}
export interface ClassifierIdentity {
  source: "heuristic" | "host" | "hosted" | "local";
  local: boolean;
  model: string;
  adapter?: string;
  revision?: string;
  modelResolution?: "provider";
  requestedModel?: string;
  modelSource?: "provider-reported" | "configured-unverified";
}
export interface Classification {
  source: "heuristic" | "host" | "hosted" | "local";
  category: TaskCategory;
  difficulty: number;
  confidence: number;
  latencyMs: number;
  costUsd: number | null;
  estimatedCostUsd?: number | null;
  accounting?: RequestAccounting;
  evidence: string;
  execution?: ClassifierIdentity;
  declaredExecution?: ClassifierIdentity;
  status?: "ok" | "error" | "not-run";
  decisionStatus?: DecisionResponse["status"];
  issues?: Issue[];
}
export interface Route {
  id: string;
  model: string;
  available: boolean;
  local: boolean;
  capabilities: string[];
  tools: string[];
  contextTokens: number;
  maxOutputTokens: number;
  quality: {
    value: number;
    basis: "measured" | "simulation";
    evidence: string;
  };
  taskQuality?: Partial<
    Record<
      TaskCategory,
      {
        easy: number;
        hard: number;
        basis: "measured" | "simulation";
        evidence: string;
      }
    >
  >;
  latencyMs: {
    value: number;
    basis: "measured" | "simulation";
    evidence: string;
  };
  pricing: null | {
    inputPerMillion: number;
    outputPerMillion: number;
    cachedInputPerMillion?: number;
    basis: "configured" | "simulation";
    evidence: string;
  };
  cache?: {
    tokens: number;
    expiresAt: number;
    basis: "observed" | "simulation";
  };
  destination:
    | { kind: "openai-compatible"; endpoint: string; apiKeyEnv?: string }
    | { kind: "opencode"; model: string };
}
export interface Policy {
  weights: { quality: number; cost: number; latency: number };
  allowedRouteIds?: string[];
  allowedTools: string[];
  localOnly?: boolean;
  maxCostUsd?: number;
  maxLatencyMs?: number;
  minimumQuality?: number;
  allowAvailabilityFallback: boolean;
  allowQualityEscalation: boolean;
  maxAttempts: number;
}
export interface Candidate {
  routeId: string;
  eligible: boolean;
  reasons: string[];
  rankScore: number | null;
  estimatedCostUsd: number | null;
  maximumCostUsd: number | null;
  quality: Route["quality"];
  latency: Route["latencyMs"];
  cacheBasis: string;
}
export interface Selection {
  status: "selected" | "unavailable" | "unsupported";
  routeId: string | null;
  candidates: Candidate[];
  explanation: string;
  inputTokenUpperBound: number;
  outputTokens: number;
}
export interface Artifact {
  kind: "answer" | "structured" | "patch";
  text: string;
  data?: unknown;
  repair?: {
    kind: "single-hunk-counts-v1";
    originalText: string;
    originalWasMalformed: true;
    headerLine: number;
    originalHeader: string;
    normalizedHeader: string;
    validation: "syntax-only; host application and tests required";
  };
}
export interface ExecutionResult {
  status: "ok" | "unavailable" | "malformed" | "error" | "cancelled";
  artifact?: Artifact;
  actualModel: string;
  identityBasis?: "provider-reported" | "configured-unverified";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  } | null;
  costUsd: number | null;
  error?: string;
  rawOutput?: string;
}
export type Executor = (
  route: Route,
  task: Task,
  options: { signal?: AbortSignal; outputTokens: number },
) => Promise<ExecutionResult>;
export interface VerificationResult {
  adequate: boolean;
  evidence: string;
  latencyMs: number;
  costUsd: number | null;
}
export type VerificationRecord =
  | (VerificationResult & {
      status: "ok";
      identity: import("../runtime/contract").Identity | null;
    })
  | {
      status: "skipped" | "error" | "cancelled";
      identity: import("../runtime/contract").Identity | null;
      adequate: null;
      evidence: string;
      latencyMs: number;
      costUsd: number | null;
      issues?: string[];
    };
export interface Attempt extends ExecutionResult {
  routeId: string;
  latencyMs: number;
  trigger: "initial" | "availability-fallback" | "quality-escalation";
  reservedCostUsd: number | null;
  verification?: VerificationRecord;
}
export interface RoutingResult {
  schemaVersion: "1";
  taskId: string;
  status: "ok" | "unavailable" | "unsupported" | "error" | "cancelled";
  classification: Classification;
  selection: Selection;
  attempts: Attempt[];
  outcome: {
    artifact?: Artifact;
    actualRouteId: string | null;
    actualModel: string | null;
    totalLatencyMs: number;
    totalCostUsd: number | null;
    failure?: string;
    note?: string;
  };
}
export interface RouterConfig {
  classifier?:
    | { kind: "heuristic" }
    | { kind: "hosted-jev"; apiKeyEnv: string }
    | { kind: "local" };
  localRuntime?: import("./mac-adapter").MacRuntimeConfig;
  routes: Route[];
  policy: Policy;
  decisionEndpoint?: { url: string; local: boolean; apiKeyEnv?: string };
}
