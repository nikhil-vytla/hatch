import { capitalize, type Currency, detectCurrency, findAmount, removeRange, tidy } from "./common";

export type ExpenseData = { amount: number | null; item: string; currency: Currency };

export function parseExpense(text: string): ExpenseData {
  const amount = findAmount(text);
  const rest = amount ? removeRange(text, amount.index, amount.length) : text;
  const on = rest.match(/\b(?:on|for|at|in)\s+(.+)$/i);
  let item = on ? on[1] : rest;
  item = item.replace(/\b(?:spent|paid|pay|bought|cost|costs|rupees|rs|bucks|dollars|today|yesterday)\b/gi, " ");
  return { amount: amount?.value ?? null, item: capitalize(tidy(item)), currency: detectCurrency(text) };
}

export function completeExpense(d: ExpenseData) {
  return (d.amount ? 0.6 : 0) + (d.item ? 0.4 : 0);
}
