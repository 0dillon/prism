"""Rate limit counters, through the privileged pool.

**Why row-level security cannot cover this.** `rate_limit_counters` has no policies and no
grants at all, deliberately: a learner must not be able to read their own remaining quota, and
certainly not reset it. A table with no policy is deny-all to `authenticated`, so the only way
to reach it is the service role.

**Tables affected.** `public.rate_limit_counters`, and nothing else.

**The invariant this module is responsible for.** It touches exactly one counter row per call,
identified by a bucket key the caller computed from an operation plus either the authenticated
user id or the request address. It never reads another table, never returns anything but a
count, and takes no user-supplied SQL. The bypass is as narrow as the task.
"""

from __future__ import annotations

from app.db.privileged import PrivilegedReason, privileged_session

# Increment and read in one statement: concurrent callers serialise on the row rather than
# all reading the same under-limit value and all proceeding.
INCREMENT_SQL = """
insert into public.rate_limit_counters (bucket, window_start, hits)
values ($1, to_timestamp($2), 1)
on conflict (bucket, window_start) do update
  set hits = public.rate_limit_counters.hits + 1
returning hits
"""


async def increment(sql: str, *args: object) -> int:
    """Apply one hit to a counter and return the post-increment total."""
    async with privileged_session(PrivilegedReason.RATE_LIMIT_ACCOUNTING) as connection:
        value = await connection.fetchval(sql, *args)
        return int(value or 0)


async def sweep_expired(older_than_seconds: int = 86_400) -> int:
    """Delete counter rows whose window has long passed.

    Without this the table grows without bound: a row is created per bucket per window, and
    nothing else ever removes them.
    """
    async with privileged_session(PrivilegedReason.RATE_LIMIT_ACCOUNTING) as connection:
        deleted = await connection.fetchval(
            """
            with removed as (
              delete from public.rate_limit_counters
               where window_start < now() - make_interval(secs => $1)
              returning 1
            )
            select count(*) from removed
            """,
            older_than_seconds,
        )
        return int(deleted or 0)
