/**
 * Ingestion stages shown to the user (PRD CE-1) and the progress range each one covers.
 * Progress is 0 to 100. Within a stage, callers report how far through it they are.
 */

export const INGESTION_STAGES = [
  "uploading",
  "reading",
  "extracting",
  "merging",
  "generating_quizzes",
  "tagging_signs",
  "validating",
  "ready",
] as const;
export type IngestionStage = (typeof INGESTION_STAGES)[number];

/** Plain-language label for each stage, for the upload page and screen readers. */
export const STAGE_LABELS: Record<IngestionStage, string> = {
  uploading: "Uploading",
  reading: "Reading the file",
  extracting: "Finding the key ideas",
  merging: "Organizing the lesson",
  generating_quizzes: "Writing quiz questions",
  tagging_signs: "Matching sign clips",
  validating: "Checking the lesson",
  ready: "Ready for review",
};

const RANGES: Record<IngestionStage, [number, number]> = {
  uploading: [0, 2],
  reading: [2, 10],
  extracting: [10, 50],
  merging: [50, 58],
  generating_quizzes: [58, 88],
  tagging_signs: [88, 92],
  validating: [92, 98],
  ready: [100, 100],
};

/** Overall progress for being `fraction` (0 to 1) of the way through a stage. */
export function overallProgress(stage: IngestionStage, fraction = 0): number {
  const [from, to] = RANGES[stage];
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return Math.round(from + (to - from) * clamped);
}

export function isIngestionStage(value: string): value is IngestionStage {
  return (INGESTION_STAGES as readonly string[]).includes(value);
}
