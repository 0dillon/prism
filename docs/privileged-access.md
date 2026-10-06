# Privileged database access

Code holding a `PrivilegedConnection` runs as `service_role`, which bypasses row-level
security entirely. Treat it as equivalent to root access to application data.

This document is the register of every place that happens. Adding a call site means editing
three things, each of which shows up in a diff:

1. a `PrivilegedReason` member in [`app/db/privileged.py`](../backend/app/db/privileged.py);
2. the `banned-api` per-file ignore in [`pyproject.toml`](../backend/pyproject.toml);
3. the allowlist in `tests/arch/test_boundaries.py`, which fails the build otherwise.

That friction is deliberate. The question "why is this bypassing row-level security?" should
be answered in the open, by someone who had to write it down.

For each entry below, state why RLS cannot cover the case, which tables are touched, and which
authorization invariant the module is now responsible for upholding — the one RLS would
otherwise have enforced for free.

---

## `app/repositories/privileged/rate_limits.py`

**Reason:** `RATE_LIMIT_ACCOUNTING`

**Why RLS cannot cover it.** `rate_limit_counters` has no policies and no grants at all, by
design: a learner must not be able to read their own remaining quota, and certainly not reset
it. A table with RLS enabled and no policy is deny-all to `authenticated`, so the service role
is the only way to reach it.

**Tables affected.** `public.rate_limit_counters`. Nothing else.

**Invariant this module upholds.** One counter row per call, identified by a bucket key the
caller derived from an operation plus either the authenticated user id or the request address.
It reads no other table, returns nothing but a count, and accepts no user-supplied SQL. The
sweep deletes only rows whose window has already passed.

---

## Planned, not yet implemented

These have a `PrivilegedReason` reserved because the design calls for them. Each needs its own
section here before the code lands.

| Reason | Why RLS cannot cover it |
| --- | --- |
| `STRIPE_CHECKOUT_COMPLETED` | No end-user token exists; the caller is Stripe. By design **no** `authenticated` path may write `purchases`, or a learner could grant themselves entitlement. |
| `STRIPE_CHARGE_REFUNDED` | As above. Revocation is a status change, never a delete. |
| `STRIPE_ACCOUNT_UPDATED` | A creator who could set `onboarding_complete` themselves would bypass the paid-course publish gate (PRD P7-04). |
| `ORG_INVITE_ACCEPT` | The invitee is not yet a member, so no policy predicate can authorise their own insert without opening a self-join hole. |
| `GDPR_EXPORT` / `GDPR_DELETE` | Must read across every tenant-scoped table for one data subject. |
| `PLATFORM_ANALYTICS` / `MODERATION_QUEUE` | Cross-tenant by definition. Read-only and aggregate-only; must never return `render_profiles.profile` or per-row `learning_events.layout`. |
| `USAGE_ACCOUNTING` | `llm_usage` has no policies: spend data is operator data, not learner data. |
| `IDEMPOTENCY_LEDGER` | `idempotency_keys` stores stored responses; a learner reading another's would be a data leak. |

---

## Things that look like they need privilege and must not get it

Worth stating explicitly, because each is a tempting shortcut.

**`POST /api/events`.** The learner inserts their *own* events. The RLS
`WITH CHECK (user_id = auth.uid())` is what enforces "never trust a client-supplied user id"
at the database. Routing the event firehose through the privileged pool would throw that away
and put the highest-volume path in the product inside the bypass.

**Ingestion and lesson publishing.** These run through `rls_session` as the lesson owner. The
ingestion pipeline is the largest surface area in the backend; keeping it under ordinary
row-level security keeps it out of the service-role blast radius entirely.

**Reading a lesson, a profile, or mastery.** All are expressible as policies, and all are
policies.
