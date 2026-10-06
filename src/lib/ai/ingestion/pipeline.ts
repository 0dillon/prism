import { logger } from "@/lib/log";
import { type KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { generateStructured as defaultGenerate, StructuredOutputError } from "../llm";
import { UsageTracker } from "../usage";
import { chunkDocument } from "./chunk";
import { extractConcepts } from "./concepts";
import { extractSourceDocument } from "./extract";
import { mergeConcepts, createIdFactory, type IdFactory } from "./merge";
import { generateQuizItems } from "./quiz";
import { overallProgress, type IngestionStage } from "./stages";
import type { JobArtifacts, PipelineStore } from "./store";
import { ExtractionError } from "./types";
import { validateGraph, type ValidationIssue } from "./validate";

/**
 * The ingestion pipeline (PRD 5.1): read, extract concepts, merge, write quizzes,
 * validate, then leave the lesson in needs_review for a teacher.
 *
 * Every step saves its output on the job. Running the pipeline again for the same job
 * skips the steps that already finished, so a failure partway through resumes from
 * the step that failed instead of paying for the earlier steps again.
 */

export interface IngestionInput {
  jobId: string;
  lessonId: string;
  /** Where the uploaded file sits in the sources bucket. */
  sourcePath: string;
  /** Original file name. Only its extension is used. */
  fileName: string;
  lessonTitle?: string;
  store: PipelineStore;
  /** Test hooks. */
  generate?: typeof defaultGenerate;
  newId?: IdFactory;
}

export type IngestionResult =
  | {
      status: "needs_review";
      graph: KnowledgeGraph;
      warnings: ValidationIssue[];
      resumedSteps: string[];
    }
  | { status: "failed"; stage: IngestionStage; error: string };

const GENERIC_ERROR = "Something went wrong while processing the file. Please try again.";

/** A message safe to show a teacher. Internal details go to the logs, not the screen. */
export function userFacingError(error: unknown): string {
  if (error instanceof ExtractionError) return error.message;
  if (error instanceof StructuredOutputError) {
    return "The AI could not produce a usable result for this file. Please try again.";
  }
  return GENERIC_ERROR;
}

export async function runIngestion(input: IngestionInput): Promise<IngestionResult> {
  const { jobId, lessonId, store } = input;
  const generate = input.generate ?? defaultGenerate;
  const newId = input.newId ?? createIdFactory();
  const tracker = new UsageTracker();
  const resumedSteps: string[] = [];

  const job = await store.loadJob(jobId);
  const artifacts: JobArtifacts = { ...job.artifacts };
  let stage: IngestionStage = "reading";

  const usage = () => {
    const totals = tracker.totals();
    return {
      tokensIn: job.tokensIn + totals.tokensIn,
      tokensOut: job.tokensOut + totals.tokensOut,
      costUsd: job.costUsd + totals.costUsd,
    };
  };
  const report = (next: IngestionStage, fraction = 0, extra: { artifacts?: JobArtifacts } = {}) => {
    stage = next;
    return store.updateJob(jobId, {
      stage: next,
      progress: overallProgress(next, fraction),
      error: null,
      ...usage(),
      ...extra,
    });
  };

  // Progress is informational. A failed progress write must not fail the job.
  const progress = (next: IngestionStage, fraction: number) => {
    void report(next, fraction).catch((error: unknown) => {
      logger.warn("could not record ingestion progress", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  try {
    await store.setLessonStatus(lessonId, "processing");

    // Reading: extract text, then chunk it.
    if (!artifacts.source) {
      await report("reading", 0);
      const data = await store.downloadSource(input.sourcePath);
      artifacts.source = await extractSourceDocument({ fileName: input.fileName, data });
      await report("reading", 0.6, { artifacts });
    } else resumedSteps.push("source");

    if (!artifacts.chunks) {
      artifacts.chunks = chunkDocument(artifacts.source);
      await report("reading", 1, { artifacts });
    } else resumedSteps.push("chunks");

    // Extracting: candidate concepts from each chunk, in parallel.
    if (!artifacts.candidates) {
      await report("extracting", 0);
      artifacts.candidates = await extractConcepts({
        document: artifacts.source,
        chunks: artifacts.chunks,
        lessonTitle: input.lessonTitle,
        generate,
        onUsage: tracker.record,
        onProgress: (done, total) => progress("extracting", done / total),
      });
      await report("extracting", 1, { artifacts });
    } else resumedSteps.push("candidates");

    // Merging: deduplicate, order, group, assign prerequisites and ids.
    if (!artifacts.merged) {
      await report("merging", 0);
      artifacts.merged = await mergeConcepts({
        candidates: artifacts.candidates,
        lessonTitle: input.lessonTitle,
        generate,
        newId,
        onUsage: tracker.record,
      });
      await report("merging", 1, { artifacts });
    } else resumedSteps.push("merged");

    // Quizzes: at least two items per concept.
    if (!artifacts.quiz) {
      await report("generating_quizzes", 0);
      artifacts.quiz = await generateQuizItems({
        concepts: artifacts.merged.concepts,
        generate,
        newId,
        onUsage: tracker.record,
        onProgress: (done, total) => progress("generating_quizzes", done / total),
      });
      await report("generating_quizzes", 1, { artifacts });
    } else resumedSteps.push("quiz");

    // Validating: the graph must satisfy the schema and its integrity rules.
    await report("validating", 0);
    const validation = validateGraph({
      schemaVersion: 1,
      lessonId,
      title: input.lessonTitle?.trim() || artifacts.merged.title,
      overview: artifacts.merged.overview,
      language: "en",
      sections: artifacts.merged.sections,
      concepts: artifacts.merged.concepts,
      quizItems: artifacts.quiz.items,
    });
    if (!validation.ok) {
      logger.error("ingestion produced an invalid graph", {
        lessonId,
        jobId,
        errors: validation.errors.slice(0, 10),
      });
      throw new ExtractionError("The lesson could not be built from this file. Please try again.");
    }

    await store.saveDraft(lessonId, { title: validation.graph.title, graph: validation.graph });
    stage = "ready";
    await store.updateJob(jobId, {
      stage: "ready",
      progress: 100,
      error: null,
      artifacts,
      ...usage(),
    });

    return {
      status: "needs_review",
      graph: validation.graph,
      warnings: validation.warnings,
      resumedSteps,
    };
  } catch (error) {
    const message = userFacingError(error);
    logger.error("ingestion failed", {
      lessonId,
      jobId,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });
    // Keep what finished so the next run resumes here. Failing to record the failure
    // must not hide the original problem.
    await Promise.allSettled([
      store.updateJob(jobId, { stage, error: message, artifacts, ...usage() }),
      store.setLessonStatus(lessonId, "failed"),
    ]);
    return { status: "failed", stage, error: message };
  }
}
