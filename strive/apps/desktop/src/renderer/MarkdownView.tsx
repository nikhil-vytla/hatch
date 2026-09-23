// A reply's markdown, drawn from the parsed blocks.
import { Fragment } from "react";
import { type Block, type Inline, parseBlocks } from "./markdown";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((b, i) => (
        // Blocks have no identity beyond their place in the text.
        <BlockView key={`${b.kind}-${i}`} block={b} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
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
      return (
        <pre className="code" data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
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
