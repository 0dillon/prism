import { splitSentences, type Sentence } from "@/lib/speech/sentences";
import type { Concept } from "@/lib/schemas/knowledge-graph";
import { parseBlocks, parseInline, type InlineToken } from "../shared/markdown";

/**
 * What the reader shows for a concept, as pieces of text with stable ids. The same pieces
 * are drawn on screen and read aloud, so the sentence being spoken is always one the
 * learner can see, and the highlight lands on exactly that text.
 */

/** One run of text shown as a paragraph, a list item or a heading. */
export interface TextUnit {
  key: string;
  tokens: InlineToken[];
  /** The text as it reads, with Markdown marks gone. */
  text: string;
  sentences: Sentence[];
}

export type ContentBlock =
  | { kind: "paragraph"; unit: TextUnit; tone: "body" | "callout" }
  | { kind: "list"; key: string; ordered: boolean; items: TextUnit[] };

export interface ConceptContent {
  concept: Concept;
  title: TextUnit;
  blocks: ContentBlock[];
}

/** A sentence in reading order, with the id the highlight uses. */
export interface ScriptSentence {
  id: string;
  text: string;
}

export const sentenceId = (unitKey: string, index: number) => `${unitKey}#${index}`;

export function makeUnit(key: string, tokens: InlineToken[], wholeIsOneSentence = false): TextUnit {
  const text = tokens.map((token) => token.text).join("");
  const sentences: Sentence[] =
    wholeIsOneSentence && text.trim()
      ? [{ start: 0, end: text.length, text }]
      : splitSentences(text);
  return { key, tokens, text, sentences };
}

export interface ConceptContentOptions {
  showExamples: boolean;
  /** A rewritten version of the body, such as a simpler one. Replaces the concept's own body. */
  variantBody?: string;
}

export function buildConceptContent(
  concept: Concept,
  { showExamples, variantBody }: ConceptContentOptions,
): ConceptContent {
  const id = concept.id;
  // A heading is read as one piece, whatever punctuation it holds.
  const title = makeUnit(`${id}/title`, [{ text: concept.title, style: "plain" }], true);

  const markdown = (variantBody ?? concept.body).trim()
    ? (variantBody ?? concept.body)
    : concept.summary;
  const blocks: ContentBlock[] = parseBlocks(markdown).map((block, index): ContentBlock => {
    const key = `${id}/b${index}`;
    if (block.kind === "paragraph") {
      return { kind: "paragraph", tone: "body", unit: makeUnit(key, parseInline(block.text)) };
    }
    return {
      kind: "list",
      key,
      ordered: block.ordered,
      items: block.items.map((item, i) => makeUnit(`${key}/${i}`, parseInline(item))),
    };
  });

  if (concept.keyTerm && concept.definition) {
    blocks.push({
      kind: "paragraph",
      tone: "callout",
      unit: makeUnit(`${id}/term`, [
        { text: concept.keyTerm, style: "strong" },
        { text: `: ${concept.definition}`, style: "plain" },
      ]),
    });
  }
  if (showExamples) {
    concept.examples.forEach((example, index) => {
      blocks.push({
        kind: "paragraph",
        tone: "callout",
        unit: makeUnit(`${id}/ex${index}`, [
          { text: "For example: ", style: "strong" },
          ...parseInline(example),
        ]),
      });
    });
  }

  return { concept, title, blocks };
}

/** Every unit of a concept in the order it is shown. */
export function unitsOf(content: ConceptContent): TextUnit[] {
  const units: TextUnit[] = [content.title];
  for (const block of content.blocks) {
    if (block.kind === "paragraph") units.push(block.unit);
    else units.push(...block.items);
  }
  return units;
}

/** The sentences of the given concepts, in the order they are shown and should be read. */
export function buildScript(contents: readonly ConceptContent[]): ScriptSentence[] {
  return contents.flatMap((content) =>
    unitsOf(content).flatMap((unit) =>
      unit.sentences.map((sentence, index) => ({
        id: sentenceId(unit.key, index),
        text: sentence.text,
      })),
    ),
  );
}
