// Which models the forge talks to, and where the credential for them comes from. Everything here takes the environment
// and `argv` as values, so the choices are pure enough to test without a process, a network or a provider key.
//
// A model is named `provider/modelId`, split at the first slash because ids themselves may hold slashes (openrouter's
// `anthropic/claude-haiku-4.5`). `--model`/`FORGE_MODEL` picks the turn model and `--summary-model`/`FORGE_SUMMARY_MODEL`
// the compactor's; with no summary model given, the summary uses the turn model. `--base-url`/`FORGE_BASE_URL` means all
// requests go to one OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM Studio) whose model is named on the command
// line. With no model named anywhere, the first preference provider that has a configured credential wins; with no
// credential at all the choice is "demo", so the caller can run the offline scripted demo instead.
//
// Credentials are each provider's standard environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
// OPENROUTER_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY, XAI_API_KEY). A key is never read out here: only whether it is set
// (pi-ai's `getAuth` reports a source label), so nothing this module returns can leak a secret.
import type { Api, Model, ModelCost, ProviderAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** The process environment, or a fake one in tests. */
export type Env = Readonly<Record<string, string | undefined>>;

/** The model flags this module reads from `argv`; other flags belong to the caller. */
export type ModelFlags = { readonly model?: string; readonly summaryModel?: string; readonly baseUrl?: string };

/** A model and the provider that serves it, with a sentence saying why it was chosen. */
export type ServedModel = { readonly model: Model<Api>; readonly provider: Provider; readonly why: string };

/** The result of choosing models: a turn/summary pair, the offline demo, or a message naming the bad input. */
export type ModelChoice =
	| { readonly kind: "models"; readonly turn: ServedModel; readonly summary: ServedModel }
	| { readonly kind: "demo"; readonly why: string }
	| { readonly kind: "error"; readonly message: string };

/** Auto-pick order. Every id here must exist in the pi-ai catalog; test/model-config.test.ts checks that. */
export const PREFERENCE_DEFAULTS = [
	["anthropic", "claude-sonnet-5-5"],
	["openai", "gpt-5.4-mini"],
	["google", "gemini-3.8-flash"],
	["openrouter", "anthropic/claude-sonnet-5.5"],
	["deepseek", "deepseek-flash"],
	["groq", "qwen/qwen3.8-27b"],
	["xai", "grok-4.7"],
] as const;

const LOCAL_ID = "local";

const LOCAL_CONTEXT_WINDOW = 128_000;

const LOCAL_MAX_TOKENS = 8_192;

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The value of a `--name value` or `--name=value` flag, whichever came first. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
	const prefix = `${name}=`;

	for (const [i, arg] of argv.entries()) {
		if (arg === name) return argv.at(i + 1);

		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}

	return undefined;
}

/** The model flags in `argv`; a missing flag is undefined. */
export function modelFlags(argv: readonly string[]): ModelFlags {
	return { model: flagValue(argv, "--model"), summaryModel: flagValue(argv, "--summary-model"), baseUrl: flagValue(argv, "--base-url") };
}

/** `provider/modelId` in short form, for status lines and file names. */
export const describeModel = (served: ServedModel): string => `${served.model.provider}/${served.model.id}`;

/** A provider behind every built-in catalog, with auth resolved from `env` rather than the real process. */
function catalog(env: Env): MutableModels {
	const models = createModels({ authContext: { env: async (name) => env[name], fileExists: async () => false } });

	for (const provider of builtinProviders()) models.setProvider(provider);

	return models;
}

type Split = { readonly provider: string; readonly modelId: string };

/** Split at the first slash, keeping slashes in the model id. */
function splitSpec(spec: string): Split | undefined {
	const at = spec.indexOf("/");

	if (at <= 0 || at === spec.length - 1) return undefined;

	return { provider: spec.slice(0, at), modelId: spec.slice(at + 1) };
}

/** The candidates that share a substring with `needle`, or all of them when nothing is close. */
function closeMatches(needle: string, candidates: readonly string[]): readonly string[] {
	const lower = needle.toLowerCase();
	const near: string[] = [];

	for (const candidate of candidates) {
		const c = candidate.toLowerCase();

		if (c.includes(lower) || lower.includes(c)) near.push(candidate);
	}

	return near.length === 0 ? candidates : near;
}

/** A comma list, capped so one bad openrouter id cannot print 400 lines. */
function names(candidates: readonly string[]): string {
	const shown = candidates.slice(0, 25);

	return shown.join(", ") + (candidates.length > shown.length ? `, ... (${candidates.length} in all)` : "");
}

type Lookup = { readonly found: ServedModel } | { readonly missing: string };

/** One provider's model, or a message naming the provider's models. */
function serve(models: MutableModels, providerId: string, modelId: string, why: string): Lookup {
	const provider = models.getProvider(providerId);

	if (provider === undefined) {
		const ids = models.getProviders().map((p) => p.id);

		return { missing: `unknown provider "${providerId}"; providers: ${names(closeMatches(providerId, ids))}` };
	}

	const model = models.getModel(providerId, modelId);

	if (model === undefined) {
		const ids = models.getModels(providerId).map((m) => m.id);

		return { missing: `unknown model "${modelId}" for provider "${providerId}"; models of ${providerId}: ${names(closeMatches(modelId, ids))}` };
	}

	return { found: { model, provider, why } };
}

/** A named `provider/modelId` resolved against the catalog, refused up front when its provider has no credential. */
async function resolveExplicit(models: MutableModels, spec: string, source: string): Promise<Lookup> {
	const split = splitSpec(spec);

	if (split === undefined) {
		const ids = models.getProviders().map((p) => p.id);

		return { missing: `model "${spec}" is not provider/modelId; providers: ${names(ids)}` };
	}

	const lookup = serve(models, split.provider, split.modelId, `set by ${source}`);

	if ("missing" in lookup || (await models.getAuth(split.provider)) !== undefined) return lookup;

	return { missing: `no credential configured for provider "${split.provider}" (${source} named ${spec}); set its API key environment variable` };
}

/** The first preference model whose provider has a credential; undefined when none does. */
async function autoPick(models: MutableModels): Promise<ServedModel | undefined> {
	for (const [providerId, modelId] of PREFERENCE_DEFAULTS) {
		const auth = await models.getAuth(providerId);

		if (auth === undefined) continue;

		const provider = models.getProvider(providerId);
		const model = models.getModel(providerId, modelId);

		if (provider === undefined || model === undefined) continue;

		return { model, provider, why: `auto-picked ${providerId}/${modelId} (credential from ${auth.source ?? "environment"})` };
	}

	return undefined;
}

/** An OpenAI-compatible local model at zero cost, with a generous window: the server owns the real limits. */
function localModel(id: string, baseUrl: string): Model<"openai-completions"> {
	return { id, name: `Local ${id}`, api: "openai-completions", provider: LOCAL_ID, baseUrl, input: ["text"], cost: ZERO_COST, reasoning: false, contextWindow: LOCAL_CONTEXT_WINDOW, maxTokens: LOCAL_MAX_TOKENS };
}

/** The one-model (or two-model) provider for a `--base-url` endpoint. Keyless unless FORGE_API_KEY is set. */
export function localProvider(baseUrl: string, models: readonly Model<"openai-completions">[], apiKey: string | undefined): Provider {
	const auth: ProviderAuth = { apiKey: { name: "Local API key (optional)", resolve: async () => (apiKey === undefined ? { auth: {} } : { auth: { apiKey } }) } };

	return createProvider({ id: LOCAL_ID, name: "Local (OpenAI-compatible)", baseUrl, auth, models, api: openAICompletionsApi() });
}

/** The local end of a `--base-url` run; `local/` is accepted and stripped from either model name. */
function localChoice(env: Env, flags: ModelFlags, baseUrl: string): ModelChoice {
	const turnSpec = flags.model ?? env.FORGE_MODEL;

	if (turnSpec === undefined) return { kind: "error", message: "--base-url needs a --model <modelId> (or FORGE_MODEL) for the local server" };

	const turnId = stripLocal(turnSpec);
	const summarySpec = flags.summaryModel ?? env.FORGE_SUMMARY_MODEL;
	const summaryId = summarySpec === undefined ? turnId : stripLocal(summarySpec);
	const ids = summaryId === turnId ? [turnId] : [turnId, summaryId];
	const localModels = ids.map((id) => localModel(id, baseUrl));
	const provider = localProvider(baseUrl, localModels, env.FORGE_API_KEY);
	const turn: ServedModel = { model: localModels[0], provider, why: `--base-url local endpoint ${baseUrl}` };
	const summary: ServedModel = { model: localModels[localModels.length - 1], provider, why: summaryId === turnId ? "same as turn model" : `--base-url local endpoint ${baseUrl}` };

	return { kind: "models", turn, summary };
}

const stripLocal = (spec: string): string => (spec.startsWith(`${LOCAL_ID}/`) ? spec.slice(LOCAL_ID.length + 1) : spec);

/** Turn and summary models from `env` and `argv`, in the precedence the header describes. */
export async function chooseModels(input: { readonly env: Env; readonly argv: readonly string[] }): Promise<ModelChoice> {
	const flags = modelFlags(input.argv);
	const baseUrl = flags.baseUrl ?? input.env.FORGE_BASE_URL;

	if (baseUrl !== undefined) return localChoice(input.env, flags, baseUrl);

	const models = catalog(input.env);
	const turnSpec = flags.model ?? input.env.FORGE_MODEL;
	const summarySpec = flags.summaryModel ?? input.env.FORGE_SUMMARY_MODEL;
	const summarySource = flags.summaryModel !== undefined ? "--summary-model" : "FORGE_SUMMARY_MODEL";
	let turn: ServedModel;

	if (turnSpec === undefined) {
		const picked = await autoPick(models);

		if (picked === undefined) {
			return { kind: "demo", why: "no provider credential found; set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY, XAI_API_KEY, or pass --base-url for a local model" };
		}

		turn = picked;
	} else {
		const found = await resolveExplicit(models, turnSpec, flags.model !== undefined ? "--model" : "FORGE_MODEL");

		if ("missing" in found) return { kind: "error", message: found.missing };

		turn = found.found;
	}

	if (summarySpec === undefined) return { kind: "models", turn, summary: turn };

	const summary = await resolveExplicit(models, summarySpec, summarySource);

	if ("missing" in summary) return { kind: "error", message: summary.missing };

	return { kind: "models", turn, summary: summary.found };
}

/** One line per provider that has a credential, with its chat model ids, for `--list-models`. */
export async function configuredModels(env: Env): Promise<string[]> {
	const models = catalog(env);
	const lines: string[] = [];

	for (const provider of models.getProviders()) {
		const auth = await models.getAuth(provider.id);

		if (auth === undefined) continue;

		const ids = models.getModels(provider.id).map((model) => model.id);

		lines.push(`${provider.id} (${auth.source ?? "configured"}): ${ids.join(", ")}`);
	}

	return lines;
}
