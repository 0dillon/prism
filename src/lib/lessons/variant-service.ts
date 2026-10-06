import { z } from "zod";
import { mapWithConcurrency } from "@/lib/async";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { generateVariant, READING_LEVELS, type Variant } from "@/lib/ai/tutor/variants";
import type { ReadingLevel } from "@/lib/ai/prompts/rewrite-concept";
import { generateStructured as defaultGenerate } from "@/lib/ai/llm";
import { logger } from "@/lib/log";
import { KnowledgeGraph, type Concept } from "@/lib/schemas/knowledge-graph";

/**
 * Reading-level variants (PRD 5.5, 6.2). A variant is generated once per
 * (lesson, concept, graph version, level), stored permanently, and served from the cache
 * after that. Learners read the cache through row-level security; only the server writes it.
 */

export const VariantRequest = z.object({
  lessonId: z.uuid("Missing the lesson."),
  conceptId: z.string().min(1, "Missing the concept.").max(100),
  readingLevel: z.enum(READING_LEVELS, "Choose plain or simple."),
});
export type VariantRequest = z.infer<typeof VariantRequest>;

export interface VariantResult extends Variant {
  graphVersion: number;
  /** True if it came from the cache with no model call. */
  cached: boolean;
}

type Generate = typeof defaultGenerate;

export interface VariantDeps {
  generate?: Generate;
  /** Calls already running, so two learners asking at once cost one model call. */
  inflight?: Map<string, Promise<Variant>>;
}

const sharedInflight = new Map<string, Promise<Variant>>();
const UNIQUE_VIOLATION = "23505";

interface Clients {
  user: UserClient;
  admin: UserClient;
}

async function readCached(
  client: UserClient,
  lessonId: string,
  conceptId: string,
  graphVersion: number,
  level: ReadingLevel,
): Promise<Variant | null> {
  const { data } = await client
    .from("concept_variants")
    .select("body, summary")
    .eq("lesson_id", lessonId)
    .eq("concept_id", conceptId)
    .eq("graph_version", graphVersion)
    .eq("reading_level", level)
    .maybeSingle();
  return data ?? null;
}

/** Generates a variant and stores it. If another request stored it first, that one wins. */
async function createVariant(
  admin: UserClient,
  lessonId: string,
  concept: Concept,
  graphVersion: number,
  level: ReadingLevel,
  generate: Generate | undefined,
): Promise<Variant> {
  const variant = await generateVariant({ concept, level, generate });
  const { error } = await admin.from("concept_variants").insert({
    lesson_id: lessonId,
    concept_id: concept.id,
    graph_version: graphVersion,
    reading_level: level,
    body: variant.body,
    summary: variant.summary,
  });
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return (await readCached(admin, lessonId, concept.id, graphVersion, level)) ?? variant;
    }
    // The learner still gets their text; it just will not be cached this time.
    logger.warn("could not store variant", {
      lessonId,
      conceptId: concept.id,
      error: error.message,
    });
  }
  return variant;
}

export async function getOrCreateVariant(
  clients: Clients,
  input: VariantRequest,
  deps: VariantDeps = {},
): Promise<VariantResult> {
  const { data: lesson, error } = await clients.user
    .from("lessons")
    .select("id, status, graph, graph_version")
    .eq("id", input.lessonId)
    .maybeSingle();
  if (error)
    throw new ServiceError(500, "read_failed", "We could not load the lesson. Please try again.");
  // Row-level security hides lessons the user may not read, so this is also the access check.
  if (!lesson || lesson.status !== "published")
    throw new ServiceError(404, "not_found", "Lesson not found.");

  const graph = KnowledgeGraph.safeParse(lesson.graph);
  if (!graph.success)
    throw new ServiceError(500, "corrupt_graph", "This lesson could not be loaded.");
  // Only concepts in the lesson are rewritten, so a request cannot be used to run arbitrary text.
  const concept = graph.data.concepts.find((c) => c.id === input.conceptId);
  if (!concept)
    throw new ServiceError(404, "concept_not_found", "That concept is not in this lesson.");

  const version = lesson.graph_version;
  const cached = await readCached(clients.user, lesson.id, concept.id, version, input.readingLevel);
  if (cached) return { ...cached, graphVersion: version, cached: true };

  const inflight = deps.inflight ?? sharedInflight;
  const key = `${lesson.id}:${concept.id}:${version}:${input.readingLevel}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = createVariant(
      clients.admin,
      lesson.id,
      concept,
      version,
      input.readingLevel,
      deps.generate,
    ).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }

  try {
    return { ...(await pending), graphVersion: version, cached: false };
  } catch (cause) {
    logger.error("variant generation failed", {
      lessonId: lesson.id,
      conceptId: concept.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw new ServiceError(
      503,
      "variant_unavailable",
      "We could not make a simpler version right now. The original is still available.",
    );
  }
}

/**
 * Generates the plain variant of every concept in a freshly published lesson, so the
 * first learner who asks for it gets it instantly. Failures are logged and skipped.
 */
export async function prewarmPlainVariants(
  admin: UserClient,
  lessonId: string,
  deps: { generate?: Generate; concurrency?: number } = {},
): Promise<{ created: number; skipped: number; failed: number }> {
  const { data: lesson } = await admin
    .from("lessons")
    .select("graph, graph_version, status")
    .eq("id", lessonId)
    .maybeSingle();
  const graph = lesson ? KnowledgeGraph.safeParse(lesson.graph) : null;
  if (!lesson || lesson.status !== "published" || !graph?.success)
    return { created: 0, skipped: 0, failed: 0 };

  const tally = { created: 0, skipped: 0, failed: 0 };
  await mapWithConcurrency(graph.data.concepts, deps.concurrency ?? 4, async (concept) => {
    try {
      if (await readCached(admin, lessonId, concept.id, lesson.graph_version, "plain")) {
        tally.skipped += 1;
        return;
      }
      await createVariant(admin, lessonId, concept, lesson.graph_version, "plain", deps.generate);
      tally.created += 1;
    } catch (error) {
      tally.failed += 1;
      logger.warn("could not prewarm variant", {
        lessonId,
        conceptId: concept.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return tally;
}
