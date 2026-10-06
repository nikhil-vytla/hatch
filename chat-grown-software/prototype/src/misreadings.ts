// Misunderstandings: coherent programs that do the wrong thing. Each one is a plausible reading of the user's words in
// one turn of the scenario, written as a model that misread the request would write it: clean code, no slips. They
// replace the named functions of that turn's proposal; everything else (scope, the calls the model proposes, the
// properties the user stated) stays as in the scenario.
export type Misreading = { turn: number; id: string; reading: string; forms: Record<string, string>; /** drop the turn's data migration */ noMigration?: boolean };

const VALIDATE = `  if (!(typeof amount === "number" && amount > 0)) throw new Error("amount must be positive");
  if (!category) throw new Error("category required");`;

export const MISREADINGS: Misreading[] = [
	// turn 1: "Let me record expenses: an amount and a category."
	{ turn: 1, id: "add-returns-expense", reading: "returns the recorded expense, not the count", forms: { addExpense: `function addExpense(amount, category) {
  state.expenses = state.expenses || [];
  const e = { amount, category };
  state.expenses.push(e);
  return e;
}` } },
	{ turn: 1, id: "add-lowercases", reading: "normalises categories to lower case", forms: { addExpense: `function addExpense(amount, category) {
  state.expenses = state.expenses || [];
  state.expenses.push({ amount, category: String(category).toLowerCase() });
  return state.expenses.length;
}` } },
	{ turn: 1, id: "add-newest-first", reading: "keeps the newest expense first", forms: { addExpense: `function addExpense(amount, category) {
  state.expenses = state.expenses || [];
  state.expenses.unshift({ amount, category });
  return state.expenses.length;
}` } },
	// turn 2: "What's my total so far?"
	{ turn: 2, id: "total-formatted", reading: "the total as display text", forms: { total: `function total() {
  return "$" + (state.expenses || []).reduce((sum, e) => sum + e.amount, 0).toFixed(2);
}` } },
	{ turn: 2, id: "total-count", reading: "how many expenses so far", forms: { total: `function total() {
  return (state.expenses || []).length;
}` } },
	// turn 3: "Break it down by category. The categories should always add up to the total."
	{ turn: 3, id: "by-category-pairs", reading: "a ranked list of [category, amount]", forms: { byCategory: `function byCategory() {
  const out = {};
  for (const e of state.expenses || []) out[e.category] = (out[e.category] || 0) + e.amount;
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
}` } },
	{ turn: 3, id: "by-category-share", reading: "each category's share of the total, in percent", forms: { byCategory: `function byCategory() {
  const out = {};
  const all = (state.expenses || []).reduce((s, e) => s + e.amount, 0);
  for (const e of state.expenses || []) out[e.category] = (out[e.category] || 0) + (100 * e.amount) / all;
  return out;
}` } },
	// turn 4: "Money should be in cents. When I add 0.10 and 0.20 the total should say 0.3 ..."
	{ turn: 4, id: "cents-truncate", reading: "cut to cents (floor) rather than round", forms: { cents: `function cents(x) {
  return Math.floor(x * 100 + 1e-9) / 100;
}` } },
	{ turn: 4, id: "cents-integer", reading: "report money as integer cents", forms: { cents: `function cents(x) {
  return Math.round(x * 100);
}` } },
	// turn 5: "Don't let me add an expense of zero or less, or one without a category. Throw an error."
	{ turn: 5, id: "validate-negative-only", reading: '"zero or less" as "less than zero"', forms: { addExpense: `function addExpense(amount, category) {
  if (!(typeof amount === "number" && amount >= 0)) throw new Error("amount must not be negative");
  if (!category) throw new Error("category required");
  state.expenses = state.expenses || [];
  state.expenses.push({ amount, category });
  return state.expenses.length;
}` } },
	{ turn: 5, id: "validate-skip", reading: "ignore bad input instead of throwing", forms: { addExpense: `function addExpense(amount, category) {
  if (!(typeof amount === "number" && amount > 0) || !category) return null;
  state.expenses = state.expenses || [];
  state.expenses.push({ amount, category });
  return state.expenses.length;
}` } },
	{ turn: 5, id: "validate-undefined-category", reading: '"without a category" as "category not given"', forms: { addExpense: `function addExpense(amount, category) {
  if (!(typeof amount === "number" && amount > 0)) throw new Error("amount must be positive");
  if (category === undefined) throw new Error("category required");
  state.expenses = state.expenses || [];
  state.expenses.push({ amount, category });
  return state.expenses.length;
}` } },
	// turn 6: "Let me set a monthly budget per category and tell me which ones I'm over."
	{ turn: 6, id: "budget-at-limit", reading: '"over" includes exactly at the budget', forms: { overBudget: `function overBudget() {
  const spent = byCategory();
  return Object.keys(state.budgets || {}).filter(c => (spent[c] || 0) >= state.budgets[c]).sort();
}` } },
	{ turn: 6, id: "budget-accumulates", reading: "setting a budget adds to the existing one", forms: { setBudget: `function setBudget(category, amount) {
  state.budgets = state.budgets || {};
  state.budgets[category] = (state.budgets[category] || 0) + amount;
  return state.budgets[category];
}` } },
	{ turn: 6, id: "budget-overage", reading: "how much over, per category", forms: { overBudget: `function overBudget() {
  const spent = byCategory();
  const out = {};
  for (const c of Object.keys(state.budgets || {}).sort()) if ((spent[c] || 0) > state.budgets[c]) out[c] = cents(spent[c] - state.budgets[c]);
  return out;
}` } },
	// turn 7: "Which category do I spend the most on? If two tie, pick the alphabetically first."
	{ turn: 7, id: "top-tie-last", reading: "ties go to the alphabetically last", forms: { topCategory: `function topCategory() {
  const spent = byCategory();
  let best = null;
  for (const c of Object.keys(spent).sort()) if (best === null || spent[c] >= spent[best]) best = c;
  return best;
}` } },
	{ turn: 7, id: "top-by-count", reading: '"spend the most on" as "most often"', forms: { topCategory: `function topCategory() {
  const n = {};
  for (const e of state.expenses || []) n[e.category] = (n[e.category] || 0) + 1;
  let best = null;
  for (const c of Object.keys(n).sort()) if (best === null || n[c] > n[best]) best = c;
  return best;
}` } },
	{ turn: 7, id: "top-tie-insertion", reading: "ties go to the category seen first", forms: { topCategory: `function topCategory() {
  const spent = byCategory();
  let best = null;
  for (const c of Object.keys(spent)) if (best === null || spent[c] > spent[best]) best = c;
  return best;
}` } },
	// turn 8: "Can expenses have an optional note? Like 'coffee with Sam'."
	{ turn: 8, id: "note-empty-default", reading: "every expense gets a note, empty by default", forms: { addExpense: `function addExpense(amount, category, note) {
${VALIDATE}
  state.expenses = state.expenses || [];
  state.expenses.push({ amount, category, note: note === undefined ? "" : note });
  return state.expenses.length;
}` } },
	{ turn: 8, id: "note-in-category", reading: "the note is folded into the category", forms: { addExpense: `function addExpense(amount, category, note) {
${VALIDATE}
  state.expenses = state.expenses || [];
  state.expenses.push({ amount, category: note === undefined ? category : category + ": " + note });
  return state.expenses.length;
}` } },
	{ turn: 8, id: "note-required-text", reading: "a note must be text, so a non-string note is dropped silently", forms: { addExpense: `function addExpense(amount, category, note) {
${VALIDATE}
  state.expenses = state.expenses || [];
  state.expenses.push(typeof note === "string" && note.trim() !== "" ? { amount, category, note: note.trim() } : { amount, category });
  return state.expenses.length;
}` } },
];
