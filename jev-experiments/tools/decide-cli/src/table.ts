/** Plain-text tables for the terminal. */
export function table(head: string[], rows: (string | number)[][]) {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const widths = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  // Numbers line up on the right; words read from the left.
  const numeric = head.map((_, i) => rows.length > 0 && rows.every((r) => /^[−+-]?[\d$.,%]+( |$)|^—$/.test(String(r[i]))));
  const line = (r: string[]) => r.map((c, i) => (numeric[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ").trimEnd();

  return [line(cells[0]!), widths.map((w) => "─".repeat(w)).join("  "), ...cells.slice(1).map(line)].join("\n");
}

export const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");

export const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");

export const signed = (x: number, d = 3) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}` : "—");

export const interval = ([lo, hi]: [number, number], d = 3) => `[${signed(lo, d)}, ${signed(hi, d)}]`;
