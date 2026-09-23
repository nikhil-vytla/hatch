// A reply's markdown, drawn from the parsed blocks.
import { Fragment, memo, useEffect, useState } from "react";
import remend from "remend";
import type { ThemedToken } from "shiki/core";
import { tokens } from "./highlight";
import { Icon } from "./icons";
import { type Block, type Inline, parseBlocks } from "./markdown";

/**
 * `streaming`: the text is still arriving, so markdown cut off mid-way (an
 * unclosed `**`, a fence) is completed first, and code isn't highlighted
 * until the block is done.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = parseBlocks(streaming ? remend(text) : text);

  return (
    <div className="md">
      {blocks.map((b, i) => (
        // Blocks have no identity beyond their place in the text.
        <MemoBlock key={`${b.kind}-${i}`} block={b} settled={!streaming || i < blocks.length - 1} />
      ))}
    </div>
  );
}

/** A settled block draws the same every time: re-rendering it for each streamed token would be waste. */
const MemoBlock = memo(
  function MemoBlock({ block, settled }: { block: Block; settled: boolean }) {
    return <BlockView block={block} settled={settled} />;
  },
  (a, b) => a.settled && b.settled && JSON.stringify(a.block) === JSON.stringify(b.block),
);

function BlockView({ block, settled }: { block: Block; settled: boolean }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p>
          <Inlines runs={block.inline} />
        </p>
      );
    case "heading": {
      const H = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";

      return (
        <H>
          <Inlines runs={block.inline} />
        </H>
      );
    }

    case "code":
      return <CodeBlock code={block.text} lang={block.lang} highlight={settled} />;
    case "list": {
      const L = block.ordered ? "ol" : "ul";

      return (
        <L>
          {block.items.map((item, i) => (
            <li key={`item-${i}`}>
              <Inlines runs={item} />
            </li>
          ))}
        </L>
      );
    }

    case "quote":
      return (
        <blockquote>
          <Inlines runs={block.inline} />
        </blockquote>
      );
    default:
      return block satisfies never;
  }
}

function Inlines({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((r, i) => (
        <Fragment key={`${r.kind}-${i}`}>
          <InlineView run={r} />
        </Fragment>
      ))}
    </>
  );
}

function InlineView({ run }: { run: Inline }) {
  switch (run.kind) {
    case "text":
      return <>{run.text}</>;
    case "code":
      return <code>{run.text}</code>;
    case "strong":
      return (
        <strong>
          <Inlines runs={run.children} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines runs={run.children} />
        </em>
      );
    case "link":
      // Shown, not followed: the window never navigates, and the target is the model's.
      return (
        <span className="link" title={run.href}>
          <Inlines runs={run.children} />
        </span>
      );
    default:
      return run satisfies never;
  }
}

function CodeBlock({ code, lang, highlight }: { code: string; lang: string; highlight: boolean }) {
  const [lines, setLines] = useState<ThemedToken[][]>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;

    if (highlight && lang) void tokens(code, lang).then((t) => live && setLines(t));

    return () => {
      live = false;
    };
  }, [code, lang, highlight]);

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="lang">{lang || "text"}</span>
        <button type="button" className="quiet copy" onClick={copy} aria-label="copy code">
          <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code">
        <code>
          {lines
            ? lines.map((line, i) => (
                // Lines have no identity beyond their place.
                <Fragment key={`l${i}`}>
                  {line.map((t, j) => (
                    <span key={`t${j}`} style={{ color: t.color }}>
                      {t.content}
                    </span>
                  ))}
                  {i < lines.length - 1 && "\n"}
                </Fragment>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
