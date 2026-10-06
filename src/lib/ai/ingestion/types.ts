import { z } from "zod";

/**
 * Intermediate types for the ingestion pipeline (PRD 5.1). These are persisted in
 * ingestion_jobs.artifacts so a failed job can resume, so they are Zod schemas.
 */

export const SourceKind = z.enum(["pdf", "txt", "md", "docx", "audio"]);

/** Where a piece of text came from in the original file. */
export const Locator = z.object({
  kind: z.enum(["page", "time", "offset"]),
  start: z.number(), // page number (1-based), seconds, or character offset
  end: z.number().optional(),
});
export type Locator = z.infer<typeof Locator>;

export const SourceSegment = z.object({
  text: z.string().min(1),
  locator: Locator,
  /** Set when the text is a heading. Used by the chunker to split on structure. */
  heading: z.object({ level: z.number().int().min(1).max(6) }).optional(),
});
export type SourceSegment = z.infer<typeof SourceSegment>;

/** The text of an uploaded file as ordered segments, each tied to a source location. */
export const SourceDocument = z.object({
  sourceType: SourceKind,
  segments: z.array(SourceSegment).min(1),
});
export type SourceDocument = z.infer<typeof SourceDocument>;

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}
