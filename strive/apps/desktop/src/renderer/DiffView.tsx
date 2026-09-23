// A line diff of a file's text, highlighted by its language when strive
// has a grammar for it: the before and after texts are tokenized whole (so
// multi-line constructs colour right) and each row takes its line's tokens.
import { useEffect, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { diffLines } from "./diff";
import { grammarFor, tokens } from "./highlight";

const MAX_ROWS = 400;

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

  const rows = diffLines(before, after);
  let old = 0;
  let now = 0;

  const shown = rows.slice(0, MAX_ROWS).map((row) => {
    const line = row.kind === "remove" ? coloured.before?.[old] : coloured.after?.[now];
    const numbers = { old: row.kind === "add" ? undefined : old + 1, now: row.kind === "remove" ? undefined : now + 1 };

    if (row.kind !== "add") old++;

    if (row.kind !== "remove") now++;

    return { row, line, numbers };
  });

  return (
    <pre className="diff">
      {shown.map(({ row, line, numbers }) => (
        <div key={row.n} className={`row ${row.kind}`}>
          <span className="num">{numbers.old ?? ""}</span>
          <span className="num">{numbers.now ?? ""}</span>
          <span className="sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span>
          {line
            ? line.map((t, i) => (
                // Tokens have no identity beyond their place in the line.
                <span key={`t${i}`} style={{ color: t.color }}>
                  {t.content}
                </span>
              ))
            : row.text || " "}
        </div>
      ))}
      {rows.length > MAX_ROWS && <div className="row more">… {rows.length - MAX_ROWS} more lines</div>}
    </pre>
  );
}
