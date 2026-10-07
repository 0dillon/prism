import type { UserClient } from "@/lib/api/http";

/**
 * A scripted stand-in for the Supabase client, for services whose queries are simple chains.
 * Each table answers with the result you give it, whatever filters are chained on, and every
 * chained call is recorded so a test can check what was asked. It does not apply row-level
 * security: that is proved against real SQL in src/tests/sql.
 */

export interface Answer {
  data?: unknown;
  error?: { code?: string; message: string } | null;
}

export interface TableCall {
  table: string;
  /** Each chained method with its arguments, in order, for example ["eq", ["teacher_id", "u1"]]. */
  ops: Array<[string, unknown[]]>;
}

export interface RecordingOptions {
  tables?: Record<string, Answer | Answer[]>;
  rpc?: Record<string, Answer | ((args: Record<string, unknown>) => Answer)>;
}

export function recordingClient(options: RecordingOptions = {}) {
  const calls: TableCall[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const queues = new Map<string, Answer[]>();
  for (const [table, answer] of Object.entries(options.tables ?? {})) {
    queues.set(table, Array.isArray(answer) ? [...answer] : [answer]);
  }

  const next = (table: string): Answer => {
    const queue = queues.get(table);
    if (!queue || queue.length === 0) return { data: [], error: null };
    // The last answer repeats, so one answer can serve several calls.
    return queue.length > 1 ? queue.shift()! : queue[0];
  };

  const from = (table: string) => {
    const call: TableCall = { table, ops: [] };
    calls.push(call);
    const resolve = (single: boolean) => {
      const answer = next(table);
      const data = single && Array.isArray(answer.data) ? (answer.data[0] ?? null) : answer.data;
      return { data: data ?? null, error: answer.error ?? null };
    };
    const builder: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, name: string) {
          if (name === "then") {
            return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              Promise.resolve(resolve(false)).then(ok, bad);
          }
          if (name === "single" || name === "maybeSingle") {
            return () => {
              call.ops.push([name, []]);
              return Promise.resolve(resolve(true));
            };
          }
          return (...args: unknown[]) => {
            call.ops.push([name, args]);
            return builder;
          };
        },
      },
    );
    return builder;
  };

  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    const entry = options.rpc?.[name];
    const answer = typeof entry === "function" ? entry(args) : (entry ?? { data: null });
    return { data: answer.data ?? null, error: answer.error ?? null };
  };

  return { client: { from, rpc } as unknown as UserClient, calls, rpcCalls };
}

/** The first recorded call on a table, for assertions. */
export function callsOn(calls: TableCall[], table: string): TableCall[] {
  return calls.filter((c) => c.table === table);
}

export function opsNamed(call: TableCall, name: string): unknown[][] {
  return call.ops.filter(([op]) => op === name).map(([, args]) => args);
}
