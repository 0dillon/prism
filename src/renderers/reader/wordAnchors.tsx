import { Fragment, type ReactNode } from "react";

/**
 * Word anchors (PRD 5.3, 5.6.2): the first letters of each word in bold, as some readers
 * find it helps them keep their place. Research support for it is limited, so it is off
 * unless the learner turns it on (`typography.wordAnchors`).
 *
 * The text is never changed. A word's bold part and the rest sit together inside one span,
 * so the characters, the order and the spaces are exactly the original text, and a screen
 * reader or a copy-and-paste gets the plain word. The bold is a visual hint only.
 */

export interface WordParts {
  /** Punctuation before the word, never bold. */
  prefix: string;
  /** The bold start of the word. Empty when the token has no letters to anchor. */
  lead: string;
  /** The rest of the word and any punctuation after it. */
  rest: string;
}

/** About two-fifths of a word is bold, and at least one letter. */
const ANCHOR_SHARE = 0.4;

const WORD = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u;
const HAS_LETTER = /\p{L}/u;

/** Splits one token (a word with any punctuation stuck to it) into its parts. */
export function splitWordAnchor(token: string): WordParts {
  const match = WORD.exec(token);
  if (!match) return { prefix: "", lead: "", rest: token };
  const [, prefix, core, suffix] = match;
  // Numbers, symbols and the like are left plain: there is nothing to anchor on.
  if (!core || !HAS_LETTER.test(core)) return { prefix: "", lead: "", rest: token };

  const letters = Array.from(core); // by character, so an accent or emoji is not cut in half
  const count = Math.max(1, Math.ceil(letters.length * ANCHOR_SHARE));
  return {
    prefix,
    lead: letters.slice(0, count).join(""),
    rest: letters.slice(count).join("") + suffix,
  };
}

/**
 * The text with each word anchored, as React nodes. Spaces between words are kept as they
 * are. With `enabled` false it returns the text as it came.
 */
export function anchorWords(text: string, enabled = true): ReactNode {
  if (!enabled || !text) return text;
  return text.split(/(\s+)/).map((token, index) => {
    if (!token || /^\s+$/.test(token)) return <Fragment key={index}>{token}</Fragment>;
    const { prefix, lead, rest } = splitWordAnchor(token);
    if (!lead) return <Fragment key={index}>{token}</Fragment>;
    return (
      <span key={index}>
        {prefix}
        <b>{lead}</b>
        {rest}
      </span>
    );
  });
}
