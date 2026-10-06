import { randomUUID } from "node:crypto";
import type { UserClient } from "@/lib/api/http";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

/**
 * A small in-memory stand-in for the Supabase client, covering the query shapes the lesson
 * service uses. It mimics the row-level security rules that matter to those queries:
 * a user sees and writes only their own lessons, and cannot write pipeline jobs.
 */
export class FakeSupabase {
  tables: Record<string, Row[]> = {
    lessons: [],
    ingestion_jobs: [],
    concept_sign_links: [],
    concept_variants: [],
    render_profiles: [],
    unmet_needs: [],
  };
  uploadUrls: { bucket: string; path: string }[] = [];
  /** Stand-ins for database functions, keyed by name. publish_lesson mimics the real one. */
  rpcHandlers: Record<
    string,
    (
      args: Record<string, unknown>,
      userId: string | null,
    ) => { data: unknown; error: { message: string; code: string } | null }
  > = {
    publish_lesson: (args, userId) => {
      const lesson = this.tables.lessons.find((l) => l.id === args.p_lesson_id);
      if (!lesson || userId === null || lesson.owner_id !== userId) {
        return { data: null, error: { message: "lesson not found", code: "P0002" } };
      }
      if (lesson.status !== "needs_review") {
        return { data: null, error: { message: "lesson is not ready to publish", code: "P0001" } };
      }
      const version = (lesson.graph_version as number) + 1;
      Object.assign(lesson, { graph: args.p_graph, graph_version: version, status: "published" });
      return { data: version, error: null };
    },
  };

  /** Make the next operation on a table fail: key is `${table}.${op}`. */
  failures = new Set<string>();
  clock = () => new Date().toISOString();

  asAdmin(): UserClient {
    return this.client(null);
  }

  asUser(userId: string): UserClient {
    return this.client(userId);
  }

  seedLesson(row: Row): Row {
    const lesson = {
      id: randomUUID(),
      title: "Seeded",
      status: "uploading",
      source_path: null,
      source_type: null,
      graph_version: 0,
      created_at: this.clock(),
      updated_at: this.clock(),
      ...row,
    };
    this.tables.lessons.push(lesson);
    return lesson;
  }

  seedJob(row: Row): Row {
    const job = {
      id: randomUUID(),
      stage: "uploading",
      progress: 0,
      error: null,
      created_at: this.clock(),
      updated_at: this.clock(),
      ...row,
    };
    this.tables.ingestion_jobs.push(job);
    return job;
  }

  private visible(table: string, userId: string | null): Row[] {
    const rows = this.tables[table];
    if (userId === null) return rows;
    if (table === "lessons") {
      return rows.filter((r) => r.owner_id === userId || r.status === "published");
    }
    if (table === "render_profiles") return rows.filter((r) => r.user_id === userId);
    if (table === "concept_variants") {
      const readable = new Set(
        this.tables.lessons
          .filter((l) => l.owner_id === userId || l.status === "published")
          .map((l) => l.id),
      );
      return rows.filter((r) => readable.has(r.lesson_id));
    }
    const owned = new Set(
      this.tables.lessons.filter((r) => r.owner_id === userId).map((r) => r.id),
    );
    return rows.filter((r) => owned.has(r.lesson_id));
  }

  private client(userId: string | null): UserClient {
    const fail = (key: string) => {
      if (this.failures.has(key)) {
        this.failures.delete(key);
        return { message: `injected failure for ${key}` };
      }
      return null;
    };

    const from = (table: string) => {
      let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
      let conflictColumn = "id";
      let payload: Row | Row[] = {};
      const firstRow = (): Row => (Array.isArray(payload) ? payload[0] : payload);
      const filters: [string, unknown][] = [];
      let ordering: { column: string; ascending: boolean } | null = null;
      let limit: number | null = null;
      let returning = false;

      const run = (): Result => {
        const injected = fail(`${table}.${op}`);
        if (injected) return { data: null, error: injected };

        if (op === "upsert") {
          if (userId !== null && firstRow().user_id !== userId) {
            return {
              data: null,
              error: { message: "new row violates row-level security policy" },
            };
          }
          const existing = this.tables[table].find(
            (r) => r[conflictColumn] === firstRow()[conflictColumn],
          );
          if (existing) Object.assign(existing, firstRow(), { updated_at: this.clock() });
          else
            this.tables[table].push({ id: randomUUID(), created_at: this.clock(), ...firstRow() });
          return { data: null, error: null };
        }

        if (op === "insert") {
          // PostgREST accepts one row or an array of rows.
          const incoming: Row[] = Array.isArray(payload)
            ? (payload as unknown as Row[])
            : [payload];
          const inserted: Row[] = [];
          for (const item of incoming) {
            if (userId !== null) {
              const allowed = table === "lessons" && item.owner_id === userId;
              if (!allowed) {
                return {
                  data: null,
                  error: { message: "new row violates row-level security policy" },
                };
              }
            }
            if (table === "concept_variants") {
              const key = (r: Row) =>
                [r.lesson_id, r.concept_id, r.graph_version, r.reading_level].join("|");
              if (this.tables.concept_variants.some((r) => key(r) === key(item))) {
                return {
                  data: null,
                  error: { message: "duplicate key value", code: "23505" } as { message: string },
                };
              }
            }
            const row = {
              id: randomUUID(),
              created_at: this.clock(),
              updated_at: this.clock(),
              ...item,
            };
            this.tables[table].push(row);
            inserted.push(row);
          }
          return { data: inserted, error: null };
        }

        let rows = this.visible(table, userId).filter((r) => filters.every(([c, v]) => r[c] === v));

        if (op === "update") {
          if (userId !== null && table !== "lessons" && table !== "concept_sign_links") {
            return { data: null, error: { message: "permission denied for table" } };
          }
          if (userId !== null && table === "lessons")
            rows = rows.filter((r) => r.owner_id === userId);
          rows.forEach((r) => Object.assign(r, firstRow(), { updated_at: this.clock() }));
          return { data: rows, error: null };
        }
        if (op === "delete") {
          if (userId !== null && table === "lessons")
            rows = rows.filter((r) => r.owner_id === userId);
          this.tables[table] = this.tables[table].filter((r) => !rows.includes(r));
          return { data: rows, error: null };
        }

        if (ordering) {
          const { column, ascending } = ordering;
          rows = [...rows].sort((a, b) =>
            String(a[column]) < String(b[column]) ? (ascending ? -1 : 1) : ascending ? 1 : -1,
          );
        }
        if (limit !== null) rows = rows.slice(0, limit);
        return { data: rows, error: null };
      };

      const one = (required: boolean): Result => {
        const result = run();
        if (result.error) return result;
        const rows = result.data as Row[];
        if (rows.length === 0 && required) {
          return { data: null, error: { message: "no rows returned" } };
        }
        return { data: rows[0] ?? null, error: null };
      };

      const builder = {
        select: () => {
          returning = true;
          return builder;
        },
        upsert: (row: Row, options?: { onConflict?: string }) => {
          op = "upsert";
          payload = row;
          conflictColumn = options?.onConflict ?? "id";
          return builder;
        },
        insert: (row: Row | Row[]) => {
          op = "insert";
          payload = row;
          return builder;
        },
        update: (row: Row) => {
          op = "update";
          payload = row;
          return builder;
        },
        delete: () => {
          op = "delete";
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
          ordering = { column, ascending: options?.ascending ?? true };
          return builder;
        },
        limit: (n: number) => {
          limit = n;
          return builder;
        },
        single: () => Promise.resolve(one(true)),
        maybeSingle: () => Promise.resolve(one(false)),
        then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) => {
          void returning;
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return builder;
    };

    const rpc = async (name: string, args: Record<string, unknown>) => {
      const injected = fail(`rpc.${name}`);
      if (injected) return { data: null, error: { ...injected, code: "XX000" } };
      const handler = this.rpcHandlers[name];
      if (!handler)
        return { data: null, error: { message: `unknown function ${name}`, code: "42883" } };
      return handler(args, userId);
    };

    const storage = {
      from: (bucket: string) => ({
        createSignedUploadUrl: async (path: string) => {
          const injected = fail("storage.sign");
          if (injected) return { data: null, error: injected };
          this.uploadUrls.push({ bucket, path });
          return {
            data: {
              path,
              token: "upload-token",
              signedUrl: `https://storage.test/${bucket}/${path}?token=upload-token`,
            },
            error: null,
          };
        },
      }),
    };

    return { from, storage, rpc } as unknown as UserClient;
  }
}
