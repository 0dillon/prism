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
  tables: Record<string, Row[]> = { lessons: [], ingestion_jobs: [] };
  uploadUrls: { bucket: string; path: string }[] = [];
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
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row = {};
      const filters: [string, unknown][] = [];
      let ordering: { column: string; ascending: boolean } | null = null;
      let limit: number | null = null;
      let returning = false;

      const run = (): Result => {
        const injected = fail(`${table}.${op}`);
        if (injected) return { data: null, error: injected };

        if (op === "insert") {
          if (userId !== null) {
            const allowed = table === "lessons" && payload.owner_id === userId;
            if (!allowed) {
              return {
                data: null,
                error: { message: "new row violates row-level security policy" },
              };
            }
          }
          const row = {
            id: randomUUID(),
            created_at: this.clock(),
            updated_at: this.clock(),
            ...payload,
          };
          this.tables[table].push(row);
          return { data: [row], error: null };
        }

        let rows = this.visible(table, userId).filter((r) => filters.every(([c, v]) => r[c] === v));

        if (op === "update") {
          if (userId !== null && table !== "lessons") {
            return { data: null, error: { message: "permission denied for table" } };
          }
          if (userId !== null) rows = rows.filter((r) => r.owner_id === userId);
          rows.forEach((r) => Object.assign(r, payload, { updated_at: this.clock() }));
          return { data: rows, error: null };
        }
        if (op === "delete") {
          if (userId !== null) rows = rows.filter((r) => r.owner_id === userId);
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
        insert: (row: Row) => {
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

    return { from, storage } as unknown as UserClient;
  }
}
