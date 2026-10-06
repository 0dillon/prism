import { Fragment, type ReactNode } from "react";
import { styled, type InlineStyle } from "../shared/markdown";
import { sentenceId, type TextUnit } from "./content";
import { anchorWords } from "./wordAnchors";

interface Piece {
  text: string;
  style: InlineStyle;
  /** Which sentence the piece belongs to, or null for the space between sentences. */
  sentence: number | null;
}

/**
 * Cuts a unit's styled tokens at its sentence boundaries, so each sentence can be wrapped
 * on its own while bold, italic and code stay where they were.
 */
export function piecesOf(unit: TextUnit): Piece[] {
  const pieces: Piece[] = [];
  let offset = 0;
  for (const token of unit.tokens) {
    const tokenStart = offset;
    const tokenEnd = offset + token.text.length;
    offset = tokenEnd;

    let cursor = tokenStart;
    const push = (to: number, sentence: number | null) => {
      if (to > cursor) {
        pieces.push({
          text: token.text.slice(cursor - tokenStart, to - tokenStart),
          style: token.style,
          sentence,
        });
        cursor = to;
      }
    };
    unit.sentences.forEach((sentence, index) => {
      if (sentence.end <= cursor || sentence.start >= tokenEnd) return;
      push(Math.max(sentence.start, cursor), null); // space before the sentence
      push(Math.min(sentence.end, tokenEnd), index);
    });
    push(tokenEnd, null);
  }
  return pieces;
}

interface RichTextProps {
  unit: TextUnit;
  /** Bold the start of each word. */
  anchors: boolean;
  /** Wrap each sentence in its own span, so one can be highlighted. */
  markSentences: boolean;
  /** The id of the sentence being read, if any. */
  activeSentenceId?: string | null;
}

/**
 * A unit of text with its bold, italic and code, optional word anchors, and optional
 * sentence highlighting. The characters on screen are always exactly the unit's text.
 */
export function RichText({ unit, anchors, markSentences, activeSentenceId }: RichTextProps) {
  const render = (piece: Piece, key: number): ReactNode =>
    styled(piece.style, anchorWords(piece.text, anchors), key);

  const pieces = piecesOf(unit);
  if (!markSentences) return <>{pieces.map(render)}</>;

  const out: ReactNode[] = [];
  let group: { sentence: number; nodes: ReactNode[] } | null = null;
  const flush = () => {
    if (!group) return;
    const id = sentenceId(unit.key, group.sentence);
    const active = id === activeSentenceId;
    out.push(
      <span key={`s${group.sentence}`} data-sentence={id} data-active={active ? "true" : undefined}>
        {group.nodes}
      </span>,
    );
    group = null;
  };
  pieces.forEach((piece, index) => {
    if (piece.sentence === null) {
      flush();
      out.push(<Fragment key={`g${index}`}>{render(piece, index)}</Fragment>);
      return;
    }
    if (group && group.sentence !== piece.sentence) flush();
    group ??= { sentence: piece.sentence, nodes: [] };
    group.nodes.push(render(piece, index));
  });
  flush();
  return <>{out}</>;
}
