# Prism Backend

FastAPI service implementing the Prism backend contracts defined in [`../PRISM_PRD.md`](../PRISM_PRD.md).

The PRD is the primary source of truth. This service is an architectural deviation from PRD section 7
(which specifies Next.js Route Handlers); the deviation and its rationale are recorded in PRD
section 9.1. API paths and request/response semantics are preserved exactly.

## Layout

| Path | Responsibility |
| --- | --- |
| `app/api/` | HTTP layer only: routing, request/response schemas, error envelope |
| `app/core/` | Config, logging, request correlation, rate limiting, idempotency |
| `app/auth/` | Supabase JWT verification (JWKS), authenticated principal |
| `app/db/` | Connection pools, the RLS session chokepoint, privileged access |
| `app/schemas/` | Canonical contract models, transcribed from PRD sections 5.2-5.7 |
| `app/domain/` | Pure business rules. No I/O |
| `app/repositories/` | Data access. Takes a connection, returns models |
| `app/ai/` | LLM gateway, provider implementations, prompts, structured extraction |
| `app/ingestion/` | Pipeline stages, artifact store, runners |
| `app/speech/` | STT/TTS provider interfaces |
| `app/storage/` | Object storage paths and signed URLs |

Dependency direction is strictly one way:

```
api -> domain services -> domain logic -> repositories / provider interfaces -> infrastructure
```

## Prerequisites

- [uv](https://docs.astral.sh/uv/) (the project pins CPython 3.13 via `.python-version`)
- Docker Desktop, for the local Supabase stack used by database tests
- Node, for `npx supabase` (no global install required)

## Setup

```bash
uv sync --extra dev
cp .env.example .env     # then fill in local values
```

## Running

```bash
uv run uvicorn app.main:app --reload
```

- `GET /health/live` - process liveness. Never touches dependencies.
- `GET /health/ready` - dependency readiness. Use this for load balancer traffic gating.
- `GET /docs` - OpenAPI documentation (non-production environments only).

## Tests

```bash
uv run ruff check .
uv run mypy app
uv run pytest -m "not requires_db"      # no infrastructure needed

# Database, RLS and security tests need the local Supabase stack:
npx supabase start
npx supabase db reset
npx supabase test db                    # pgTAP
uv run pytest -m requires_db
```

## Security invariants

These are enforced mechanically, not by convention. Breaking one fails the build.

1. The authenticated principal comes from a verified Supabase JWT. No request model anywhere
   accepts a client-supplied user id; `tests/arch/` asserts this by introspection.
2. Every table has row-level security enabled *and* forced, and at least one policy.
   `tests/rls/test_matrix.py` discovers tables from `information_schema`, so a new table added
   without policies fails CI automatically.
3. Request-path database access goes through `app/db/rls.py::rls_session`, which sets the
   identity as transaction-local state. Privileged (service-role) access requires an explicit
   `PrivilegedReason` and is import-banned outside an allowlist in `pyproject.toml`.
4. LLM output is untrusted data. It is validated before it becomes application state, and it can
   never reject a graph, choose a path, or alter authorization.
