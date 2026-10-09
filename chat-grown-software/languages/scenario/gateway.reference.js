// The intended program for the gateway scenario, turn by turn (what the simulated user has in mind).
// Each entry is the list of function declarations added or replaced in that turn.
export const TURNS = [
	[`function record_usage(key, model, tokens) {
  state.calls = state.calls || [];
  state.calls.push({ key, model, tokens });
  return usage(key);
}`, `function usage(key) {
  return (state.calls || []).filter((c) => c.key === key).reduce((s, c) => s + c.tokens, 0);
}`],
	[`function set_price(model, cents) {
  state.prices = state.prices || {};
  state.prices[model] = cents;
  return cents;
}`, `function cost(key) {
  const prices = state.prices || {};
  const cents = (state.calls || []).filter((c) => c.key === key).reduce((s, c) => s + (c.tokens / 1000) * (prices[c.model] || 0), 0);
  return Math.round(cents) / 100;
}`],
	[`function set_quota(key, tokens) {
  if (usage(key) > tokens) throw new Error("already over that quota");
  state.quotas = state.quotas || {};
  state.quotas[key] = tokens;
  return tokens;
}`, `function record_usage(key, model, tokens) {
  const quota = (state.quotas || {})[key];
  if (quota !== undefined && usage(key) + tokens > quota) throw new Error("over quota");
  state.calls = state.calls || [];
  state.calls.push({ key, model, tokens });
  return usage(key);
}`],
	[`function record_usage(key, model, tokens) {
  if (typeof key !== "string" || key === "") throw new Error("key required");
  if (typeof model !== "string" || model === "") throw new Error("model required");
  if (!Number.isInteger(tokens) || tokens <= 0) throw new Error("tokens must be a positive whole number");
  const quota = (state.quotas || {})[key];
  if (quota !== undefined && usage(key) + tokens > quota) throw new Error("over quota");
  state.calls = state.calls || [];
  state.calls.push({ key, model, tokens });
  return usage(key);
}`],
	[`function top_spender() {
  const keys = [...new Set((state.calls || []).map((c) => c.key))].sort();
  let best = null;
  for (const k of keys) if (best === null || cost(k) > cost(best)) best = k;
  return best;
}`],
];

// Invariants as JS checks over `state` (each kernel implements them natively).
export const INVARIANTS = [
	{ name: "calls-shape", check: `(state.calls ?? []).every(c => typeof c.key === "string" && c.key.length > 0 && typeof c.model === "string" && c.model.length > 0 && Number.isInteger(c.tokens) && c.tokens > 0 && Object.keys(c).length === 3)` },
	{ name: "prices-shape", check: `Object.values(state.prices ?? {}).every(p => typeof p === "number" && p >= 0)` },
	{ name: "quotas-shape", check: `Object.values(state.quotas ?? {}).every(q => Number.isInteger(q) && q >= 0)` },
	{ name: "within-quota", check: `Object.entries(state.quotas ?? {}).every(([k, q]) => (state.calls ?? []).filter(c => c.key === k).reduce((s, c) => s + c.tokens, 0) <= q)` },
	{ name: "known-keys", check: `Object.keys(state).every(k => k === "calls" || k === "prices" || k === "quotas")` },
];
