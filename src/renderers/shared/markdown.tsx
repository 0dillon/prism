import { Fragment, type ReactNode } from "react";

/**
 * A small, safe renderer for the plain Markdown in a concept's body: paragraphs, bullet and
 * numbered lists, and bold, italic and code inside them. It builds React elements and never
 * sets HTML, so text from a source document cannot inject markup. Headings in a body are
 * shown as bold paragraphs, so they cannot break the page's heading order.
 */

export type Block =
  { kind: "paragraph"; text: string } | { kind: "list"; ordered: boolean; items: string[] };

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;

export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };

  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "paragraph", text: `**${heading[1].trim()}**` });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushParagraph();
      const ordered = numbered !== null;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[1].trim());
      continue;
    }
    // A wrapped line belongs to the item above it, or else starts or continues a paragraph.
    if (list && /^\s+\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

// Underscores only count at the edge of a word, so snake_case_names are left alone.
const INLINE =
  /(\*\*[^*\n]+\*\*|(?<![A-Za-z0-9])__[^_\n]+__(?![A-Za-z0-9])|`[^`\n]+`|\*[^*\s][^*\n]*\*|(?<![A-Za-z0-9])_[^_\s][^_\n]*_(?![A-Za-z0-9]))/g;

export type InlineStyle = "plain" | "strong" | "em" | "code";

export interface InlineToken {
  /** The text with its Markdown marks taken off. */
  text: string;
  style: InlineStyle;
}

/**
 * Splits a line into plain, bold, italic and code pieces. Anything that is not clearly
 * one of those stays as plain text. Joining the tokens' text gives the line as it reads,
 * which is what read-aloud and highlighting work from.
 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    if (
      ((part.startsWith("**") && part.endsWith("**")) ||
        (part.startsWith("__") && part.endsWith("__"))) &&
      part.length > 4
    ) {
      tokens.push({ text: part.slice(2, -2), style: "strong" });
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      tokens.push({ text: part.slice(1, -1), style: "code" });
    } else if (
      ((part.startsWith("*") && part.endsWith("*")) ||
        (part.startsWith("_") && part.endsWith("_"))) &&
      part.length > 2
    ) {
      tokens.push({ text: part.slice(1, -1), style: "em" });
    } else {
      tokens.push({ text: part, style: "plain" });
    }
  }
  return tokens;
}

/** The text of a line as it reads, with the Markdown marks gone. */
export function plainText(markdown: string): string {
  return parseInline(markdown)
    .map((token) => token.text)
    .join("");
}

/** Wraps already-rendered children in the element for a style. */
export function styled(style: InlineStyle, children: ReactNode, key?: string | number): ReactNode {
  switch (style) {
    case "strong":
      return <strong key={key}>{children}</strong>;
    case "em":
      return <em key={key}>{children}</em>;
    case "code":
      return <code key={key}>{children}</code>;
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}

export function renderInline(text: string): ReactNode[] {
  return parseInline(text).map((token, index) => styled(token.style, token.text, index));
}

export function MarkdownBody({ markdown, className }: { markdown: string; className?: string }) {
  const blocks = parseBlocks(markdown);
  return (
    <div className={className ?? "flex flex-col gap-3"}>
      {blocks.map((block, index) =>
        block.kind === "paragraph" ? (
          <p key={index}>{renderInline(block.text)}</p>
        ) : block.ordered ? (
          <ol key={index} className="list-decimal ps-6">
            {block.items.map((item, i) => (
              <li key={i}>{renderInline(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={index} className="list-disc ps-6">
            {block.items.map((item, i) => (
              <li key={i}>{renderInline(item)}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
