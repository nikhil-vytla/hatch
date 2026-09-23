// A line diff for showing an edit: the longest common subsequence of lines,
// kept, with what's between removed then added. Edits are small snippets; a
// large one falls back to all-removed then all-added.

export type DiffRow = { kind: "keep" | "add" | "remove"; text: string; n: number };

const LIMIT = 2000;

export function diffLines(before: string, after: string): DiffRow[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const rows: Omit<DiffRow, "n">[] = [];

  if (a.length * b.length > LIMIT * LIMIT) {
    for (const text of a) rows.push({ kind: "remove", text });

    for (const text of b) rows.push({ kind: "add", text });

    return rows.map((r, n) => ({ ...r, n }));
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

  return rows.map((r, n) => ({ ...r, n }));
}
