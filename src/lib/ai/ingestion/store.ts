import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/lib/supabase/database.types";
import { BUCKETS } from "@/lib/supabase/storage";
import { Concept, QuizItem, Section, type KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { Chunk } from "./chunk";
import { CandidateConcept } from "./concepts";
import { type IngestionStage } from "./stages";
import type { SignGloss, SignLink } from "./signs";
import { ExtractionError, SourceDocument } from "./types";

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
  signs: z.array(z.object({ conceptId: z.string(), signClipId: z.string() })).optional(),
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
  /** The glosses of the sign clip library, for sign tagging. */
  listSignGlosses(): Promise<SignGloss[]>;
  /** Saves proposed links as unverified. Links that already exist, verified or not, are kept. */
  saveSignLinks(lessonId: string, links: SignLink[]): Promise<void>;
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
      if (error || !data) {
        // The usual cause is an upload that never finished. Say so, in words for a teacher.
        throw new ExtractionError("We could not find the uploaded file. Please upload it again.");
      }
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

    async listSignGlosses() {
      const { data, error } = await admin
        .from("sign_clips")
        .select("id, gloss")
        .eq("language", "ase");
      if (error) throw new Error(`Could not read the sign library: ${error.message}`);
      return data;
    },

    async saveSignLinks(lessonId, links) {
      if (links.length === 0) return;
      const { error } = await admin.from("concept_sign_links").upsert(
        links.map((link) => ({
          lesson_id: lessonId,
          concept_id: link.conceptId,
          sign_clip_id: link.signClipId,
          verified: false,
        })),
        { onConflict: "lesson_id,concept_id", ignoreDuplicates: true },
      );
      if (error) throw new Error(`Could not save sign links: ${error.message}`);
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
