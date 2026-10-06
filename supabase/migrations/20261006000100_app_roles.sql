-- Application database roles and the private helper schema.
--
-- Two login roles, both NOINHERIT, neither owning anything, neither holding BYPASSRLS.
--
-- NOINHERIT is the load-bearing detail. `prism_app` is a *member* of `authenticated` but does
-- not automatically hold its privileges: it must SET ROLE explicitly, which the per-request
-- RLS session does. A code path that acquires a connection and forgets to establish the
-- identity therefore gets "permission denied for table lessons" - a loud failure in CI -
-- rather than silently returning every row in the table.
--
-- Contrast the naive alternative of connecting as `postgres`: that role has BYPASSRLS, so the
-- same forgotten SET ROLE would return the entire database with no error whatsoever. That is
-- the failure mode this file exists to make impossible.

-- ---------------------------------------------------------------------------
-- Private schema for SECURITY DEFINER helpers.
--
-- Policies that query the table they protect recurse (Postgres raises "infinite recursion
-- detected in policy"). Helpers here are owned by `postgres`, so their bodies read those
-- tables without re-triggering policy evaluation, which breaks the cycle. They live in a
-- schema that is not exposed through PostgREST so they are never directly callable by a
-- client.
-- ---------------------------------------------------------------------------
create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated, anon, service_role;

-- Default-deny: helper functions are granted individually, as they are defined.
alter default privileges in schema private revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Login roles.
--
-- Passwords are supplied by the deployment, never committed. Locally, the Supabase CLI
-- stack is reached as `postgres`, and these roles exist so the RLS session and the
-- privileged session can be tested exactly as they behave in production.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'prism_app') then
    create role prism_app login noinherit password 'prism_app_local_only';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'prism_service') then
    create role prism_service login noinherit password 'prism_service_local_only';
  end if;
end
$$;

-- prism_app may become `authenticated` or `anon`, and nothing else. It must never be able to
-- reach service_role: that is asserted by a test, because it is the difference between a bug
-- and a full data breach.
grant anon, authenticated to prism_app;
grant service_role to prism_service;

-- Neither login role holds privileges of its own. Everything flows through the role it
-- assumes for the transaction.
revoke all on all tables in schema public from prism_app, prism_service;
revoke all on all functions in schema public from prism_app, prism_service;
revoke all on all sequences in schema public from prism_app, prism_service;

grant usage on schema public to prism_app, prism_service;
