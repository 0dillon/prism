/**
 * Text matching used to check that model output is grounded in the source. Models
 * often change quote styles, dashes, and whitespace when they copy text, so matching
 * ignores those differences while still requiring the same words in the same order.
 */

/** Lowercases and flattens typography so two spellings of the same text compare equal. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[​-‍﻿­]/g, "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Whether `excerpt` appears in `source`, ignoring case, quote style, dashes, and whitespace. */
export function containsExcerpt(source: string, excerpt: string): boolean {
  const needle = normalizeForMatch(excerpt);
  return needle.length > 0 && normalizeForMatch(source).includes(needle);
}

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

// Common words carry no evidence that two passages say the same thing.
const STOPWORDS = new Set(
  (
    "a an the and or but of to in on at by for with from as is are was were be been it its this that these those " +
    "we you they he she i our your their what which who when then than so into about over there here not no"
  ).split(" "),
);

function wordSet(text: string): Set<string> {
  const words = normalizeForMatch(text).match(/[a-z0-9']+/g) ?? [];
  return new Set(words.filter((word) => !STOPWORDS.has(word)));
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  // Dice coefficient: extra words in the candidate lower the score, so tight matches win.
  return (2 * shared) / (a.size + b.size);
}

/**
 * Finds the passage of `source` that best matches a paraphrased `excerpt`: one to three
 * consecutive sentences. Returns the source's own wording, or null if nothing matches
 * well enough. Used to repair near-miss excerpts instead of discarding good concepts.
 */
export function closestSourcePassage(
  source: string,
  excerpt: string,
  minScore = 0.6,
): string | null {
  const target = wordSet(excerpt);
  if (target.size < 3) return null;

  const sentences = source
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraph.split(SENTENCE_BOUNDARY))
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  let best: { score: number; text: string } | null = null;
  for (let start = 0; start < sentences.length; start++) {
    for (let length = 1; length <= 3 && start + length <= sentences.length; length++) {
      const text = sentences.slice(start, start + length).join(" ");
      const score = overlapScore(target, wordSet(text));
      if (score > (best?.score ?? 0) + 1e-9) best = { score, text };
    }
  }
  return best && best.score >= minScore ? best.text : null;
}

/** Cuts text to at most `max` characters, at a word boundary, adding no ellipsis. */
export function clampText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "");
}
