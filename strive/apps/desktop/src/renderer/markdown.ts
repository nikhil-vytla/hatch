// The markdown the agent writes, parsed into blocks and inline runs the app
// draws as React elements. Never HTML: the text comes from the model.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; inline: Inline[] };

const FENCE = /^```\s*([\w+-]*)\s*$/;

const HEADING = /^(#{1,3})\s+(.*)$/;

const BULLET = /^\s*[-*+]\s+(.*)$/;

const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

const QUOTE = /^>\s?(.*)$/;

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const startsBlock = (line: string) =>
    FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || QUOTE.test(line);

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);

    if (fence) {
      const body: string[] = [];
      i++;

      while (i < lines.length && !FENCE.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++; // the closing fence, or the end of an unclosed one
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);

    if (heading) {
      const level = Math.min(3, (heading[1] ?? "#").length);
      blocks.push({
        kind: "heading",
        level: level === 1 ? 1 : level === 2 ? 2 : 3,
        inline: parseInline(heading[2] ?? ""),
      });
      i++;
      continue;
    }

    const list = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : undefined;

    if (list) {
      const items: Inline[][] = [];

      while (i < lines.length && list.test(lines[i] ?? "")) {
        items.push(parseInline(list.exec(lines[i] ?? "")?.[1] ?? ""));
        i++;
      }

      blocks.push({ kind: "list", ordered: list === NUMBERED, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];

      while (i < lines.length && QUOTE.test(lines[i] ?? "")) body.push(QUOTE.exec(lines[i++] ?? "")?.[1] ?? "");
      blocks.push({ kind: "quote", inline: parseInline(body.join(" ")) });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const body: string[] = [];

    while (i < lines.length && (lines[i] ?? "").trim() && !startsBlock(lines[i] ?? "")) body.push(lines[i++] ?? "");
    blocks.push({ kind: "paragraph", inline: parseInline(body.join("\n")) });
  }

  return blocks;
}

/** Code first, so nothing inside backticks is read as emphasis or a link. */
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\[([^\]\n]+)\]\(([^)\s]+)\)|\*([^*\n]+?)\*|(?<![\w])_([^_\n]+?)_(?![\w])/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;

  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;

    if (start > at) out.push({ kind: "text", text: text.slice(at, start) });
    const [, code, strong1, strong2, linkText, href, em1, em2] = m;

    if (code !== undefined) out.push({ kind: "code", text: code });
    else if (strong1 !== undefined || strong2 !== undefined)
      out.push({ kind: "strong", children: parseInline(strong1 ?? strong2 ?? "") });
    else if (linkText !== undefined && href !== undefined)
      out.push({ kind: "link", href, children: parseInline(linkText) });
    else out.push({ kind: "em", children: parseInline(em1 ?? em2 ?? "") });

    at = start + m[0].length;
  }

  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });

  return out;
}
