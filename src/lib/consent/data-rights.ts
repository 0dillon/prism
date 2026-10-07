import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * A learner's right to a copy of their data, and to ask for it to be deleted (PRD 6.4, P6-16).
 * The export is read with the learner's own session, so row-level security means it can hold
 * only their own records. A deletion is recorded as a request and carried out by the operator
 * (scripts/process-deletions.ts), because removing an account cannot be undone.
 */

const PAGE = 1000;
/** A safety stop, far above any real learner: 200 pages of 1,000 events. */
const MAX_PAGES = 200;

export interface DataExport {
  version: 1;
  exportedAt: string;
  account: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  consent: Record<string, unknown> | null;
  classes: unknown[];
  mastery: unknown[];
  events: unknown[];
  requests: unknown[];
}

async function allRows(
  read: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await read(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

export async function exportMyData(
  user: UserClient,
  admin: UserClient,
  userId: string,
  now: Date = new Date(),
): Promise<DataExport> {
  try {
    const [account, settings, consent, classes, mastery, events, requests] = await Promise.all([
      user
        .from("users_public")
        .select("display_name, is_creator, created_at")
        .eq("id", userId)
        .maybeSingle(),
      user
        .from("render_profiles")
        .select("profile, share_with_teachers, created_at, updated_at")
        .eq("user_id", userId)
        .maybeSingle(),
      user
        .from("user_consents")
        .select("status, requested_at, granted_at, granted_by")
        .eq("user_id", userId)
        .maybeSingle(),
      allRows((from, to) =>
        user
          .from("enrollments")
          .select("classroom_id, created_at")
          .eq("student_id", userId)
          .range(from, to),
      ),
      allRows((from, to) =>
        user
          .from("concept_mastery")
          .select("lesson_id, concept_id, status, attempts, correct_count, updated_at")
          .eq("user_id", userId)
          .order("updated_at")
          .range(from, to),
      ),
      allRows((from, to) =>
        user
          .from("learning_events")
          .select(
            "id, lesson_id, graph_version, type, concept_id, quiz_item_id, correct, duration_ms, layout, occurred_at",
          )
          .eq("user_id", userId)
          .order("occurred_at")
          .range(from, to),
      ),
      user
        .from("data_requests")
        .select("kind, status, created_at, completed_at")
        .eq("user_id", userId),
    ]);
    for (const result of [account, settings, consent, requests]) {
      if (result.error) throw new Error(result.error.message);
    }

    const stamp = now.toISOString();
    // Recording the export is a courtesy to the audit trail; it must never block the download.
    const logged = await admin
      .from("data_requests")
      .insert({ user_id: userId, kind: "export", status: "completed", completed_at: stamp });
    if (logged.error)
      logger.warn("could not record a data export", { error: logged.error.message });

    return {
      version: 1,
      exportedAt: stamp,
      account: account.data,
      settings: settings.data,
      consent: consent.data,
      classes,
      mastery,
      events,
      requests: requests.data ?? [],
    };
  } catch (error) {
    logger.error("could not export a learner's data", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ServiceError(
      500,
      "export_failed",
      "We could not prepare your data. Please try again.",
    );
  }
}

export interface DeletionState {
  /** When deletion was asked for, or null if it has not been. */
  requestedAt: string | null;
}

export async function loadDeletionState(user: UserClient, userId: string): Promise<DeletionState> {
  const { data } = await user
    .from("data_requests")
    .select("created_at")
    .eq("user_id", userId)
    .eq("kind", "delete")
    .eq("status", "requested")
    .maybeSingle();
  return { requestedAt: data?.created_at ?? null };
}

/** Records a request to delete the account and all of its records. Asking twice is harmless. */
export async function requestDeletion(user: UserClient, userId: string): Promise<DeletionState> {
  const { error } = await user.from("data_requests").insert({ user_id: userId, kind: "delete" });
  // The database allows one open deletion request, so a second ask just reports the first.
  if (error && error.code !== "23505") {
    logger.error("could not record a deletion request", { error: error.message });
    throw new ServiceError(
      500,
      "request_failed",
      "We could not record your request. Please try again.",
    );
  }
  return loadDeletionState(user, userId);
}
