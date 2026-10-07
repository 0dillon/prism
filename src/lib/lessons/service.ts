import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { runIngestion, type IngestionResult } from "@/lib/ai/ingestion/pipeline";
import { isIngestionStage, STAGE_LABELS, type IngestionStage } from "@/lib/ai/ingestion/stages";
import { createSupabaseStore, type PipelineStore } from "@/lib/ai/ingestion/store";
import { logger } from "@/lib/log";
import { assertIngestionAllowed } from "@/lib/orgs/spend";
import {
  BUCKETS,
  createSignedUploadUrl,
  fileExtension,
  MAX_UPLOAD_BYTES,
  sourcePath,
  sourceTypeFromFileName,
  type SignedUpload,
  type SourceType,
} from "@/lib/supabase/storage";

/**
 * Lesson upload and ingestion, behind the API routes (PRD 7.5). Authorization lives
 * here: the user's own client reads and writes what row-level security allows, and the
 * admin client is used only for pipeline tables no user may write, after ownership has
 * been checked.
 */

/** Source types the extractor can read today. DOCX and audio join in P2-19 and P2-18. */
export const SUPPORTED_SOURCE_TYPES: ReadonlySet<SourceType> = new Set(["pdf", "txt", "md"]);

/** A run that reported progress this recently is treated as still going. */
export const STALE_RUN_MS = 2 * 60 * 1000;

export const CreateLessonInput = z.object({
  fileName: z.string().trim().min(1, "Choose a file.").max(255, "That file name is too long."),
  fileSize: z
    .number()
    .int("The file size must be a whole number of bytes.")
    .positive("The file is empty.")
    .max(MAX_UPLOAD_BYTES, "Files can be up to 50 MB."),
  title: z.string().trim().max(120, "Use 120 characters or fewer for the title.").optional(),
  /** The school the lesson is for. Optional: a teacher in one school does not need to say. */
  orgId: z.uuid().optional(),
});
export type CreateLessonInput = z.infer<typeof CreateLessonInput>;

export interface Clients {
  /** Runs as the signed-in user. Row-level security applies. */
  user: UserClient;
  /** Service role. Bypasses row-level security. */
  admin: UserClient;
}

export interface CreatedLesson {
  lessonId: string;
  jobId: string;
  upload: SignedUpload;
}

function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return (
    (dot > 0 ? base.slice(0, dot) : base).replace(/[_-]+/g, " ").trim().slice(0, 120) ||
    "Untitled lesson"
  );
}

/**
 * The school a new lesson is for: the one the teacher asked for if they teach there, else the
 * school they have been in longest, else none (an independent creator). The database refuses
 * a school they do not belong to, so this is a convenience and not the safeguard.
 */
async function resolveLessonOrg(
  user: UserClient,
  userId: string,
  requested: string | undefined,
): Promise<string | null> {
  const { data } = await user
    .from("org_memberships")
    .select("org_id")
    .eq("user_id", userId)
    .in("role", ["teacher", "principal"])
    .order("created_at", { ascending: true });
  const orgs = (data ?? []).map((m) => m.org_id);
  if (requested) {
    if (!orgs.includes(requested)) {
      throw new ServiceError(403, "forbidden", "You do not teach in that school.");
    }
    return requested;
  }
  return orgs[0] ?? null;
}

/** Creates the lesson and its job, and returns a signed URL the browser uploads the file to. */
export async function createLesson(
  clients: Clients,
  userId: string,
  input: CreateLessonInput,
): Promise<CreatedLesson> {
  const type = sourceTypeFromFileName(input.fileName);
  if (!type) {
    throw new ServiceError(
      400,
      "unsupported_type",
      `Files of type .${fileExtension(input.fileName) || "unknown"} are not accepted. Use PDF, TXT, or Markdown.`,
    );
  }
  if (!SUPPORTED_SOURCE_TYPES.has(type)) {
    throw new ServiceError(
      400,
      "unsupported_yet",
      type === "audio"
        ? "Audio files are not supported yet. Use PDF, TXT, or Markdown."
        : "Word documents are not supported yet. Use PDF, TXT, or Markdown.",
    );
  }

  const orgId = await resolveLessonOrg(clients.user, userId, input.orgId);
  // A school that has used its monthly AI budget cannot start new uploads.
  if (orgId) await assertIngestionAllowed(clients.admin, orgId);

  const { data: lesson, error } = await clients.user
    .from("lessons")
    .insert({
      owner_id: userId,
      org_id: orgId,
      title: input.title || titleFromFileName(input.fileName),
      status: "uploading",
      source_type: type,
    })
    .select("id")
    .single();
  if (error || !lesson) {
    logger.error("could not create lesson", { error: error?.message });
    throw new ServiceError(
      500,
      "create_failed",
      "We could not create the lesson. Please try again.",
    );
  }

  try {
    const path = sourcePath(userId, lesson.id, input.fileName);
    const updated = await clients.user
      .from("lessons")
      .update({ source_path: path })
      .eq("id", lesson.id);
    if (updated.error) throw new Error(updated.error.message);

    const job = await clients.admin
      .from("ingestion_jobs")
      .insert({ lesson_id: lesson.id, stage: "uploading", progress: 0 })
      .select("id")
      .single();
    if (job.error || !job.data) throw new Error(job.error?.message ?? "no job row");

    const upload = await createSignedUploadUrl(clients.user, BUCKETS.sources, path);
    return { lessonId: lesson.id, jobId: job.data.id, upload };
  } catch (cause) {
    logger.error("lesson setup failed; removing the lesson", {
      lessonId: lesson.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    await clients.user.from("lessons").delete().eq("id", lesson.id);
    throw new ServiceError(
      500,
      "create_failed",
      "We could not prepare the upload. Please try again.",
    );
  }
}

interface OwnedLesson {
  id: string;
  org_id: string | null;
  title: string;
  status: string;
  source_path: string | null;
  source_type: string | null;
}

async function loadOwnedLesson(
  user: UserClient,
  userId: string,
  lessonId: string,
): Promise<OwnedLesson> {
  const { data, error } = await user
    .from("lessons")
    .select("id, owner_id, org_id, title, status, source_path, source_type")
    .eq("id", lessonId)
    .maybeSingle();
  if (error) {
    logger.error("could not read lesson", { lessonId, error: error.message });
    throw new ServiceError(500, "read_failed", "We could not load the lesson. Please try again.");
  }
  // A lesson the user cannot see and one they do not own look the same.
  if (!data || data.owner_id !== userId)
    throw new ServiceError(404, "not_found", "Lesson not found.");
  return data;
}

export interface StartedIngestion {
  jobId: string;
  /** Runs the pipeline. The route hands this to `after()` so the response is not held up. */
  run: () => Promise<IngestionResult>;
}

/**
 * Starts, or resumes, ingestion for a lesson the user owns. Marks the lesson as
 * processing straight away so a poll right after this call already sees it.
 */
export async function startIngestion(
  clients: Clients,
  userId: string,
  lessonId: string,
  options: { store?: PipelineStore; now?: () => number; run?: typeof runIngestion } = {},
): Promise<StartedIngestion> {
  const lesson = await loadOwnedLesson(clients.user, userId, lessonId);

  if (lesson.status === "published") {
    throw new ServiceError(409, "already_published", "This lesson is already published.");
  }
  if (!lesson.source_path || !lesson.source_type) {
    throw new ServiceError(409, "no_source", "Upload a file for this lesson first.");
  }
  if (lesson.org_id) await assertIngestionAllowed(clients.admin, lesson.org_id);

  const jobs = await clients.admin
    .from("ingestion_jobs")
    .select("id, updated_at")
    .eq("lesson_id", lessonId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (jobs.error)
    throw new ServiceError(500, "read_failed", "We could not load the lesson. Please try again.");

  const now = (options.now ?? Date.now)();
  let jobId = jobs.data[0]?.id;

  if (jobId && lesson.status === "processing") {
    const lastActivity = Date.parse(jobs.data[0].updated_at);
    if (now - lastActivity < STALE_RUN_MS) {
      throw new ServiceError(409, "already_running", "This lesson is already being processed.");
    }
  }

  if (!jobId) {
    const created = await clients.admin
      .from("ingestion_jobs")
      .insert({ lesson_id: lessonId, stage: "uploading", progress: 0 })
      .select("id")
      .single();
    if (created.error || !created.data) {
      throw new ServiceError(
        500,
        "create_failed",
        "We could not start processing. Please try again.",
      );
    }
    jobId = created.data.id;
  }

  const store = options.store ?? createSupabaseStore(clients.admin);
  await store.setLessonStatus(lessonId, "processing");

  const execute = options.run ?? runIngestion;
  const resolvedJobId = jobId;
  return {
    jobId: resolvedJobId,
    run: () =>
      execute({
        jobId: resolvedJobId,
        lessonId,
        sourcePath: lesson.source_path as string,
        fileName: `source.${fileExtension(lesson.source_path as string)}`,
        store,
      }),
  };
}

export interface LessonStatus {
  lessonId: string;
  lessonStatus: string;
  stage: IngestionStage;
  stageLabel: string;
  progress: number;
  /** Set when the run failed. Written for a teacher to read. */
  error: string | null;
  /** True once the lesson is ready for the teacher to review. */
  ready: boolean;
}

export async function getLessonStatus(
  user: UserClient,
  userId: string,
  lessonId: string,
): Promise<LessonStatus> {
  const lesson = await loadOwnedLesson(user, userId, lessonId);
  const { data, error } = await user
    .from("ingestion_jobs")
    .select("stage, progress, error")
    .eq("lesson_id", lessonId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error)
    throw new ServiceError(500, "read_failed", "We could not load the status. Please try again.");

  const job = data[0];
  const stage: IngestionStage = job && isIngestionStage(job.stage) ? job.stage : "uploading";
  const ready = lesson.status === "needs_review" || lesson.status === "published";
  return {
    lessonId,
    lessonStatus: lesson.status,
    stage: ready ? "ready" : stage,
    stageLabel: STAGE_LABELS[ready ? "ready" : stage],
    progress: ready ? 100 : (job?.progress ?? 0),
    error:
      lesson.status === "failed" ? (job?.error ?? "Processing failed. Please try again.") : null,
    ready,
  };
}
