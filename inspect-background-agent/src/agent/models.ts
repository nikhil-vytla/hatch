/** Known-good free OpenCode models for local hatch runs. */
export const FREE_OPENCODE_MODELS = [
  { providerID: "opencode", modelID: "big-pickle" },
  { providerID: "opencode", modelID: "ling-3.0-flash-free" },
  { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
  { providerID: "opencode", modelID: "mimo-v2.5-free" },
  { providerID: "opencode", modelID: "north-mini-code-free" },
] as const;

export type ModelRef = {
  readonly providerID: string;
  readonly modelID: string;
};

export function resolveModel(envModel?: string, envProvider?: string): ModelRef {
  const providerID = envProvider ?? "opencode";
  const modelID = envModel ?? "big-pickle";
  const known = FREE_OPENCODE_MODELS.find(
    (m) => m.providerID === providerID && m.modelID === modelID,
  );
  return known ?? { providerID, modelID };
}

export function listModels(): readonly ModelRef[] {
  return FREE_OPENCODE_MODELS;
}
