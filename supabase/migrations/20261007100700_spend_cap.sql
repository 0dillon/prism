-- Organization AI spend (PRD 6.2, P6-15). Ingestion cost is already recorded per job in
-- ingestion_jobs. A lesson now carries the organization it was made for, so that cost can be
-- added up per organization and compared with the principal's monthly cap.
--
-- Only ingestion is attributed so far. Variants, tutoring and other model calls are not yet
-- recorded against an organization (PRD 9.1).

alter table public.lessons
  add constraint lessons_org_id_fkey
  foreign key (org_id) references public.organizations (id) on delete set null;

-- A lesson can be made for an organization only by someone who teaches in it. Without this,
-- anyone could point a lesson at another school and spend that school's budget.
drop policy lessons_insert_own on public.lessons;
create policy lessons_insert_own on public.lessons
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and (org_id is null or public.org_role(org_id) in ('teacher', 'principal'))
  );

drop policy lessons_update_own on public.lessons;
create policy lessons_update_own on public.lessons
  for update to authenticated
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and (org_id is null or public.org_role(org_id) in ('teacher', 'principal'))
  );

-- The principal sets the cap; the school's name is theirs to change too. Nothing else on the
-- organization (its address, its creator) is editable from a client.
revoke update on public.organizations from authenticated;
grant update (name, monthly_spend_cap_usd) on public.organizations to authenticated;

create index ingestion_jobs_created_idx on public.ingestion_jobs (created_at);

-- The cap and what has been spent this calendar month (UTC). Callable by the organization's
-- principal and by the server (no signed-in user), which checks the cap before ingestion.
create function public.org_spend(p_org uuid)
returns table (cap_usd numeric, spent_usd numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.org_role(p_org) is distinct from 'principal' then
    raise exception 'only the principal can see this' using errcode = '42501';
  end if;
  return query
  select
    o.monthly_spend_cap_usd,
    coalesce((
      select sum(j.cost_usd)
      from public.ingestion_jobs j
      join public.lessons l on l.id = j.lesson_id
      where l.org_id = o.id
        and j.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
    ), 0)
  from public.organizations o
  where o.id = p_org;
end;
$$;

revoke all on function public.org_spend(uuid) from public, anon;
grant execute on function public.org_spend(uuid) to authenticated, service_role;
