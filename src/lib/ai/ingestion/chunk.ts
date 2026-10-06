import { z } from "zod";
import { Locator, type SourceDocument } from "./types";

/**
 * Step 3 of ingestion (PRD 5.1): split a SourceDocument into chunks small enough for one
 * LLM call. Split on headings first, then by size with overlap. Every chunk keeps the
 * locators of the segments it contains so concepts can be traced back to the source.
 */

export const Chunk = z.object({
  id: z.string(),
  index: z.number().int().min(0),
  /** Headings that open sections inside this chunk, in order. */
  headings: z.array(z.string()),
  text: z.string().min(1),
  locators: z.array(Locator).min(1),
  tokenEstimate: z.number().int().min(1),
});
export type Chunk = z.infer<typeof Chunk>;

export interface ChunkOptions {
  /** Hard limit per chunk, including overlap and headings. PRD: about 1,500. */
  maxTokens?: number;
  /** Tail of the previous chunk repeated at the start of a continuation. PRD: 150. */
  overlapTokens?: number;
}

export const DEFAULT_MAX_TOKENS = 1500;
export const DEFAULT_OVERLAP_TOKENS = 150;

/** A cheap token estimate (about four characters per token) that errs slightly high. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Unit {
  text: string;
  locator: Locator;
  /** Units cut from the same paragraph are rejoined with a space, others with a blank line. */
  paragraph: number;
}

interface Section {
  heading?: { text: string; level: number; locator: Locator };
  units: Unit[];
}

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

function headingLine(heading: { text: string; level: number }): string {
  return `${"#".repeat(Math.min(Math.max(heading.level, 1), 6))} ${heading.text}`;
}

function sameLocator(a: Locator, b: Locator): boolean {
  return a.kind === b.kind && a.start === b.start && a.end === b.end;
}

function uniqueLocators(locators: Locator[]): Locator[] {
  const result: Locator[] = [];
  for (const locator of locators) {
    if (!result.some((existing) => sameLocator(existing, locator))) result.push(locator);
  }
  return result;
}

function sectionsOf(document: SourceDocument): Section[] {
  const sections: Section[] = [];
  let paragraph = 0;
  let current: Section = { units: [] };

  for (const segment of document.segments) {
    if (segment.heading) {
      if (current.heading || current.units.length > 0) sections.push(current);
      current = {
        heading: { text: segment.text, level: segment.heading.level, locator: segment.locator },
        units: [],
      };
    } else {
      current.units.push({ text: segment.text, locator: segment.locator, paragraph: paragraph++ });
    }
  }
  if (current.heading || current.units.length > 0) sections.push(current);
  return sections;
}

function renderUnits(units: Unit[]): string {
  let text = "";
  units.forEach((unit, i) => {
    if (i === 0) text = unit.text;
    else text += (units[i - 1].paragraph === unit.paragraph ? " " : "\n\n") + unit.text;
  });
  return text;
}

function renderSection(section: Section): string {
  const parts: string[] = [];
  if (section.heading) parts.push(headingLine(section.heading));
  if (section.units.length > 0) parts.push(renderUnits(section.units));
  return parts.join("\n\n");
}

/** Cuts text that has no sentence boundary into pieces of at most `limit` tokens, on spaces where possible. */
function hardSplit(text: string, limit: number): string[] {
  const maxChars = Math.max(limit * 4, 1);
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

/** Breaks any unit longer than `limit` tokens into sentences, then words, keeping its locator. */
function shrinkUnits(units: Unit[], limit: number): Unit[] {
  const result: Unit[] = [];
  for (const unit of units) {
    if (estimateTokens(unit.text) <= limit) {
      result.push(unit);
      continue;
    }
    for (const sentence of unit.text.split(SENTENCE_BOUNDARY)) {
      const pieces = estimateTokens(sentence) <= limit ? [sentence] : hardSplit(sentence, limit);
      for (const piece of pieces) result.push({ ...unit, text: piece });
    }
  }
  return result;
}

/**
 * The tail of a chunk to repeat at the start of the next one: whole trailing units that
 * fit the overlap budget, or, if even the last unit is too big, its last sentences.
 */
function overlapTail(units: Unit[], budget: number): Unit[] {
  const tail: Unit[] = [];
  let used = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const cost = estimateTokens(units[i].text) + 1;
    if (used + cost > budget) break;
    tail.unshift(units[i]);
    used += cost;
  }
  if (tail.length > 0 || units.length === 0) return tail;

  const last = units[units.length - 1];
  const sentences = last.text.split(SENTENCE_BOUNDARY);
  const kept: string[] = [];
  for (let i = sentences.length - 1; i >= 0; i--) {
    const cost = estimateTokens(sentences[i]) + 1;
    if (used + cost > budget) break;
    kept.unshift(sentences[i]);
    used += cost;
  }
  return kept.length > 0 ? [{ ...last, text: kept.join(" ") }] : [];
}

/** Splits one oversized section into several chunks of body units, each with heading and overlap. */
function splitSection(
  section: Section,
  maxTokens: number,
  overlapTokens: number,
): { text: string; units: Unit[]; heading?: Section["heading"] }[] {
  const headingCost = section.heading ? estimateTokens(headingLine(section.heading)) + 2 : 0;
  const overlapBudget = Math.min(overlapTokens, Math.floor((maxTokens - headingCost) / 3));
  const bodyBudget = Math.max(maxTokens - headingCost, 1);
  const units = shrinkUnits(section.units, Math.max(bodyBudget - overlapBudget - 2, 1));

  const groups: Unit[][] = [];
  let group: Unit[] = [];
  let used = 0;
  for (const unit of units) {
    const cost = estimateTokens(unit.text) + 1;
    if (group.length > 0 && used + cost > bodyBudget) {
      groups.push(group);
      const tail = overlapTail(group, overlapBudget);
      group = [...tail];
      used = tail.reduce((sum, u) => sum + estimateTokens(u.text) + 1, 0);
    }
    group.push(unit);
    used += cost;
  }
  if (group.length > 0) groups.push(group);

  return groups.map((units) => ({
    units,
    heading: section.heading,
    text: renderSection({ heading: section.heading, units }),
  }));
}

export function chunkDocument(document: SourceDocument, options: ChunkOptions = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  if (maxTokens < 50) throw new Error("maxTokens must be at least 50");
  if (overlapTokens < 0 || overlapTokens * 3 > maxTokens) {
    throw new Error("overlapTokens must be between 0 and a third of maxTokens");
  }

  const pieces: { text: string; locators: Locator[]; headings: string[] }[] = [];
  let pending: Section[] = [];
  let pendingTokens = 0;

  const flushPending = () => {
    if (pending.length === 0) return;
    pieces.push({
      text: pending.map(renderSection).join("\n\n"),
      locators: uniqueLocators(
        pending.flatMap((s) => [
          ...(s.heading ? [s.heading.locator] : []),
          ...s.units.map((u) => u.locator),
        ]),
      ),
      headings: pending.flatMap((s) => (s.heading ? [s.heading.text] : [])),
    });
    pending = [];
    pendingTokens = 0;
  };

  for (const section of sectionsOf(document)) {
    const tokens = estimateTokens(renderSection(section));
    if (tokens > maxTokens) {
      flushPending();
      for (const part of splitSection(section, maxTokens, overlapTokens)) {
        pieces.push({
          text: part.text,
          locators: uniqueLocators([
            ...(part.heading ? [part.heading.locator] : []),
            ...part.units.map((u) => u.locator),
          ]),
          headings: part.heading ? [part.heading.text] : [],
        });
      }
      continue;
    }
    // Small sections are packed together so a short document is not many tiny calls.
    const joinCost = pending.length > 0 ? 2 : 0;
    if (pending.length > 0 && pendingTokens + joinCost + tokens > maxTokens) flushPending();
    pendingTokens += (pending.length > 0 ? 2 : 0) + tokens;
    pending.push(section);
  }
  flushPending();

  return pieces.map((piece, index) => ({
    id: `chunk_${index}`,
    index,
    headings: piece.headings,
    text: piece.text,
    locators: piece.locators,
    tokenEstimate: Math.max(estimateTokens(piece.text), 1),
  }));
}
