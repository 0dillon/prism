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

/** Bold, italic and code. Anything that is not clearly one of those stays as plain text. */
export function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    if (!part) return null;
    if (
      (part.startsWith("**") && part.endsWith("**")) ||
      (part.startsWith("__") && part.endsWith("__"))
    ) {
      if (part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (
      ((part.startsWith("*") && part.endsWith("*")) ||
        (part.startsWith("_") && part.endsWith("_"))) &&
      part.length > 2
    ) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
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
