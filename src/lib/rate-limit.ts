/**
 * A small in-memory rate limiter for endpoints that cost money (PRD 6.2). It protects a
 * single server instance; the shared, per user and per IP limiter for production is task
 * P8-05. Old windows are dropped as they expire, so memory stays bounded.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until another request would be allowed. 0 when allowed. */
  retryAfterSeconds: number;
}

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Cap on tracked keys, so one caller cannot grow the map without bound. */
  maxKeys?: number;
}) {
  const hits = new Map<string, number[]>();
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;

  return {
    consume(key: string): RateLimitResult {
      const time = now();
      const cutoff = time - options.windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

      if (recent.length >= options.limit) {
        hits.set(key, recent);
        const oldest = recent[0];
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + options.windowMs - time) / 1000)),
        };
      }

      recent.push(time);
      hits.delete(key); // re-insert so the oldest keys come first for eviction
      hits.set(key, recent);
      if (hits.size > maxKeys) {
        const first = hits.keys().next().value;
        if (first !== undefined) hits.delete(first);
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
    /** Number of keys being tracked. For tests. */
    size: () => hits.size,
  };
}
