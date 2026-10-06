/**
 * Splits text into sentences, for reading aloud one sentence at a time and highlighting
 * the one being read. Each sentence keeps its position in the original text, so the
 * pieces can be mapped back onto what is on screen.
 */

export interface Sentence {
  /** Where the sentence starts in the original text. */
  start: number;
  /** Where it ends (exclusive), not counting trailing spaces. */
  end: number;
  text: string;
}

type SegmenterLike = {
  segment(input: string): Iterable<{ segment: string; index: number }>;
};

function createSegmenter(): SegmenterLike | null {
  try {
    const Segmenter = (
      Intl as unknown as {
        Segmenter?: new (locale?: string, options?: { granularity: string }) => SegmenterLike;
      }
    ).Segmenter;
    return Segmenter ? new Segmenter("en", { granularity: "sentence" }) : null;
  } catch {
    return null;
  }
}

const segmenter = createSegmenter();

// A full stop after one of these is not the end of a sentence.
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|st|no|fig|approx)\.$/i;

/** The fallback for engines without Intl.Segmenter: end at . ! or ? followed by a space. */
function splitWithRegex(text: string): Array<{ segment: string; index: number }> {
  const pieces: Array<{ segment: string; index: number }> = [];
  const pattern = /[.!?]+["')\]]*(?=\s)|\n{2,}/g;
  let from = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const end = match.index + match[0].length;
    if (ABBREVIATIONS.test(text.slice(from, end))) continue;
    pieces.push({ segment: text.slice(from, end), index: from });
    from = end;
  }
  if (from < text.length) pieces.push({ segment: text.slice(from), index: from });
  return pieces;
}

export function splitSentences(text: string, options: { useSegmenter?: boolean } = {}): Sentence[] {
  if (!text.trim()) return [];
  const useSegmenter = options.useSegmenter ?? true;
  const raw = useSegmenter && segmenter ? [...segmenter.segment(text)] : splitWithRegex(text);

  const sentences: Sentence[] = [];
  for (const { segment, index } of raw) {
    const trimmedStart = segment.length - segment.trimStart().length;
    const body = segment.trim();
    if (!body) continue;
    sentences.push({
      start: index + trimmedStart,
      end: index + trimmedStart + body.length,
      text: body,
    });
  }
  return sentences;
}
