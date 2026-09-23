// A line diff of a file's text, highlighted by its language when strive
// has a grammar for it: the before and after texts are tokenized whole (so
// multi-line constructs colour right) and each row takes its line's tokens.
import { useEffect, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { diffLines, hunks } from "./diff";
import { grammarFor, tokens } from "./highlight";

/** The most rows drawn for one file, however it is folded: a huge new file would stall the window. */
const MAX_ROWS = 2000;

/** The grammar for a path, by its extension. */
function languageOf(path?: string): string | undefined {
  const ext = path?.split("/").at(-1)?.split(".").at(-1);

  return ext ? grammarFor(ext) : undefined;
}

export function Diff({ before, after, path }: { before: string; after: string; path?: string }) {
  const lang = languageOf(path);
  const [coloured, setColoured] = useState<{ before?: ThemedToken[][]; after?: ThemedToken[][] }>({});

  useEffect(() => {
    let live = true;

    if (lang)
      void Promise.all([tokens(before, lang), tokens(after, lang)]).then(
        ([b, a]) => live && setColoured({ before: b, after: a }),
      );

    return () => {
      live = false;
    };
  }, [before, after, lang]);

  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  // Line numbers over every row first, so they stay right on both sides of a fold.
  let old = 0;
  let now = 0;

  const numbered = new Map(
    diffLines(before, after).map((row) => {
      const line = row.kind === "remove" ? coloured.before?.[old] : coloured.after?.[now];

      const numbers = {
        old: row.kind === "add" ? undefined : old + 1,
        now: row.kind === "remove" ? undefined : now + 1,
      };

      if (row.kind !== "add") old++;

      if (row.kind !== "remove") now++;

      return [row.n, { line, numbers }];
    }),
  );

  const parts = hunks(diffLines(before, after));
  let budget = MAX_ROWS;
  let cut = 0;

  return (
    <pre className="diff">
      {parts.map((part, i) => {
        const first = part.rows[0]?.n ?? i;

        if (part.kind === "gap" && !opened.has(first))
          return (
            <button
              type="button"
              key={`gap-${first}`}
              className="row gap"
              onClick={() => setOpened(new Set([...opened, first]))}
            >
              ⋯ {part.rows.length} unchanged {part.rows.length === 1 ? "line" : "lines"}
            </button>
          );

        const rows = part.rows.slice(0, Math.max(0, budget));
        budget -= rows.length;
        cut += part.rows.length - rows.length;

        return rows.map((row) => {
          const { line, numbers } = numbered.get(row.n) ?? { line: undefined, numbers: {} };

          return (
            <div key={row.n} className={`row ${row.kind}`}>
              <span className="num">{numbers.old ?? ""}</span>
              <span className="num">{numbers.now ?? ""}</span>
              <span className="sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span>
              {line
                ? line.map((t, j) => (
                    // Tokens have no identity beyond their place in the line.
                    <span key={`t${j}`} style={{ color: t.color }}>
                      {t.content}
                    </span>
                  ))
                : row.text || " "}
            </div>
          );
        });
      })}
      {cut > 0 && <div className="row more">… {cut} more lines not shown</div>}
    </pre>
  );
}
