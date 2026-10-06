import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/lib/supabase/database.types";
import { BUCKETS } from "@/lib/supabase/storage";
import { Concept, QuizItem, Section, type KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { Chunk } from "./chunk";
import { CandidateConcept } from "./concepts";
import { type IngestionStage } from "./stages";
import { SourceDocument } from "./types";

/**
 * Persistence for the ingestion pipeline. The pipeline talks to this interface so it
 * can be tested without a database; `createSupabaseStore` is the production
 * implementation and runs as the service role.
 */

export const MergedPartsSchema = z.object({
  title: z.string(),
  overview: z.string(),
  sections: z.array(Section),
  concepts: z.array(Concept),
});

export const QuizResultSchema = z.object({
  items: z.array(QuizItem),
  shortfalls: z.array(z.string()),
});

/** What each step produced. Saved on the job so a failed run resumes without repeating steps. */
export const JobArtifacts = z.object({
  source: SourceDocument.optional(),
  chunks: z.array(Chunk).optional(),
  candidates: z.array(CandidateConcept).optional(),
  merged: MergedPartsSchema.optional(),
  quiz: QuizResultSchema.optional(),
});
export type JobArtifacts = z.infer<typeof JobArtifacts>;

export interface JobState {
  stage: string;
  progress: number;
  artifacts: JobArtifacts;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface JobUpdate {
  stage?: IngestionStage;
  progress?: number;
  error?: string | null;
  artifacts?: JobArtifacts;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface PipelineStore {
  downloadSource(path: string): Promise<Uint8Array>;
  loadJob(jobId: string): Promise<JobState>;
  updateJob(jobId: string, update: JobUpdate): Promise<void>;
  setLessonStatus(
    lessonId: string,
    status: "processing" | "needs_review" | "failed",
  ): Promise<void>;
  saveDraft(lessonId: string, draft: { title: string; graph: KnowledgeGraph }): Promise<void>;
}

/** Artifacts that no longer match their schema are dropped, so that step simply runs again. */
export function parseArtifacts(raw: unknown): JobArtifacts {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const result: JobArtifacts = {};
  for (const key of Object.keys(JobArtifacts.shape) as (keyof JobArtifacts)[]) {
    if (record[key] === undefined) continue;
    const parsed = JobArtifacts.shape[key].safeParse(record[key]);
    if (parsed.success) Object.assign(result, { [key]: parsed.data });
  }
  return result;
}

type Admin = SupabaseClient<Database>;

export function createSupabaseStore(admin: Admin): PipelineStore {
  const fail = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };

  return {
    async downloadSource(path) {
      const { data, error } = await admin.storage.from(BUCKETS.sources).download(path);
      if (error || !data) throw new Error(`Could not read the uploaded file: ${error?.message}`);
      return new Uint8Array(await data.arrayBuffer());
    },

    async loadJob(jobId) {
      const { data, error } = await admin
        .from("ingestion_jobs")
        .select("stage, progress, artifacts, tokens_in, tokens_out, cost_usd")
        .eq("id", jobId)
        .single();
      if (error || !data) throw new Error(`Could not load the ingestion job: ${error?.message}`);
      return {
        stage: data.stage,
        progress: data.progress,
        artifacts: parseArtifacts(data.artifacts),
        tokensIn: Number(data.tokens_in),
        tokensOut: Number(data.tokens_out),
        costUsd: Number(data.cost_usd),
      };
    },

    async updateJob(jobId, update) {
      const row: Database["public"]["Tables"]["ingestion_jobs"]["Update"] = {};
      if (update.stage !== undefined) row.stage = update.stage;
      if (update.progress !== undefined) row.progress = Math.round(update.progress);
      if (update.error !== undefined) row.error = update.error;
      if (update.artifacts !== undefined) row.artifacts = update.artifacts as Json;
      if (update.tokensIn !== undefined) row.tokens_in = update.tokensIn;
      if (update.tokensOut !== undefined) row.tokens_out = update.tokensOut;
      if (update.costUsd !== undefined) row.cost_usd = update.costUsd;
      const { error } = await admin.from("ingestion_jobs").update(row).eq("id", jobId);
      fail("Could not update the ingestion job", error);
    },

    async setLessonStatus(lessonId, status) {
      const { error } = await admin.from("lessons").update({ status }).eq("id", lessonId);
      fail("Could not update the lesson status", error);
    },

    async saveDraft(lessonId, draft) {
      const { error } = await admin
        .from("lessons")
        .update({ title: draft.title, graph: draft.graph as Json, status: "needs_review" })
        .eq("id", lessonId);
      fail("Could not save the draft lesson", error);
    },
  };
}
