// A line diff for showing an edit: the lines both texts start and end with
// kept, and between them the longest common subsequence of lines kept, with
// what's around it removed then added. Most edits are local, so the middle
// is small; a large one falls back to all-removed then all-added.

export type DiffRow = { kind: "keep" | "add" | "remove"; text: string; n: number };

const LIMIT = 2000;

export function diffLines(before: string, after: string): DiffRow[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  let start = 0;

  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;

  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;

  const keep = (text: string | undefined) => ({ kind: "keep" as const, text: text ?? "" });

  const rows = [
    ...a.slice(0, start).map(keep),
    ...middle(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...a.slice(a.length - end).map(keep),
  ];

  return rows.map((r, n) => ({ ...r, n }));
}

/** The diff of the part between the common start and end. */
function middle(a: string[], b: string[]): Omit<DiffRow, "n">[] {
  const rows: Omit<DiffRow, "n">[] = [];

  if (a.length * b.length > LIMIT * LIMIT) {
    for (const text of a) rows.push({ kind: "remove", text });

    for (const text of b) rows.push({ kind: "add", text });

    return rows;
  }

  // lcs[i][j]: the common subsequence's length of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));

  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i];

      if (row)
        row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }

  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: "keep", text: a[i++] ?? "" });
      j++;
    } else if (j < b.length && (i === a.length || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      rows.push({ kind: "add", text: b[j++] ?? "" });
    } else {
      rows.push({ kind: "remove", text: a[i++] ?? "" });
    }
  }

  // Removals read before the additions that replace them.
  for (let k = 1; k < rows.length; k++) {
    const prev = rows[k - 1];
    const cur = rows[k];

    if (prev?.kind === "add" && cur?.kind === "remove") {
      let start = k - 1;

      while (start > 0 && rows[start - 1]?.kind === "add") start--;
      rows.splice(start, 0, ...rows.splice(k, 1));
    }
  }

  return rows;
}

/** Unchanged lines kept on each side of a change. */
export const CONTEXT = 3;

export type Hunked = { kind: "rows"; rows: DiffRow[] } | { kind: "gap"; rows: DiffRow[] };

/**
 * The rows as a reader wants them: changes with `context` unchanged lines
 * around each, and every longer unchanged run folded into a gap that can
 * be opened.
 */
export function hunks(rows: DiffRow[], context = CONTEXT): Hunked[] {
  const near = rows.map(() => false);

  rows.forEach((r, i) => {
    if (r.kind === "keep") return;

    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) near[j] = true;
  });

  const runs: Hunked[] = [];

  rows.forEach((r, i) => {
    const kind = near[i] ? "rows" : "gap";
    const last = runs.at(-1);

    if (last?.kind === kind) last.rows.push(r);
    else runs.push({ kind, rows: [r] });
  });

  // Folding a few lines hides more than it saves: short gaps stay shown.
  const out: Hunked[] = [];

  for (const run of runs) {
    const kind = run.kind === "gap" && run.rows.length < MIN_GAP ? "rows" : run.kind;
    const last = out.at(-1);

    // No argument spreading: a hunk can have more rows than a call takes arguments.
    if (last?.kind === "rows" && kind === "rows") last.rows = last.rows.concat(run.rows);
    else out.push({ kind, rows: run.rows });
  }

  return out;
}

/** The fewest unchanged lines worth folding. */
const MIN_GAP = 4;

export type Drawn = { kind: "row"; row: DiffRow } | { kind: "gap"; first: number; count: number };

/** What a diff draws, and how many rows its budgets left out. */
export type Drawing = { items: Drawn[]; cut: number };

/**
 * What to draw of `parts`: every hunk's rows, then the gaps a person opened,
 * each from a budget of its own, so opening context can never push a change
 * out of view. `cut` is how many rows the budgets left out.
 */
export function drawn(parts: Hunked[], opened: ReadonlySet<number>, max: number): Drawing {
  const items: Drawn[] = [];
  let changes = max;
  let context = max;
  let cut = 0;

  for (const part of parts) {
    const first = part.rows[0]?.n ?? 0;

    if (part.kind === "gap" && !opened.has(first)) {
      items.push({ kind: "gap", first, count: part.rows.length });
      continue;
    }

    const room = part.kind === "rows" ? changes : context;
    const shown = part.rows.slice(0, Math.max(0, room));

    if (part.kind === "rows") changes -= shown.length;
    else context -= shown.length;
    cut += part.rows.length - shown.length;

    for (const row of shown) items.push({ kind: "row", row });
  }

  return { items, cut };
}
