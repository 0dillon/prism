-- Invitations (PRD 5.8, P6-02). A principal invites someone to the organization by email
-- with a role. The link carries a random token; only its hash is stored, so a read of this
-- table cannot be used to accept an invitation. An invitation expires after 7 days and
-- can be accepted once, only by the signed-in user whose email it was sent to.

create table public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 320),
  role text not null check (role in ('principal', 'teacher')),
  token_hash bytea not null unique,
  invited_by uuid references public.users_public (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index org_invitations_org_idx on public.org_invitations (org_id);

alter table public.org_invitations enable row level security;

-- The principal sees their organization's invitations, without the token hash.
grant select (id, org_id, email, role, invited_by, expires_at, accepted_at, created_at)
  on public.org_invitations to authenticated;

create policy org_invitations_select_principal on public.org_invitations
  for select to authenticated
  using (public.org_role(org_id) = 'principal');

-- Returns the token once. It is not stored and cannot be read again.
create function public.create_invitation(p_org uuid, p_email text, p_role text)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id uuid;
  v_expires timestamptz;
begin
  if v_user is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;
  if public.org_role(p_org) is distinct from 'principal' then
    raise exception 'only a principal can invite' using errcode = '42501';
  end if;

  insert into public.org_invitations (org_id, email, role, token_hash, invited_by)
  values (p_org, lower(trim(p_email)), p_role, sha256(convert_to(v_token, 'UTF8')), v_user)
  returning id, org_invitations.expires_at into v_id, v_expires;

  insert into public.audit_log (org_id, actor_id, action, target, metadata)
  values (p_org, v_user, 'invitation.created', v_id::text,
          jsonb_build_object('email', lower(trim(p_email)), 'role', p_role));

  return query select v_id, v_token, v_expires;
end;
$$;

-- Accepting makes the caller a member. A person who is already a principal is never
-- demoted by accepting a teacher invitation.
create function public.accept_invitation(p_token text)
returns table (joined_org uuid, joined_role text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_inv public.org_invitations%rowtype;
begin
  if v_user is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;

  select * into v_inv from public.org_invitations i
  where i.token_hash = sha256(convert_to(coalesce(p_token, ''), 'UTF8'))
  for update;

  if not found or v_inv.accepted_at is not null or v_inv.expires_at <= now() then
    raise exception 'this invitation is not valid any more' using errcode = 'P0002';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_user;
  if v_email is distinct from v_inv.email then
    raise exception 'this invitation was sent to a different email address' using errcode = '42501';
  end if;

  insert into public.org_memberships (org_id, user_id, role)
  values (v_inv.org_id, v_user, v_inv.role)
  on conflict (org_id, user_id) do update
    set role = case
      when public.org_memberships.role = 'principal' then 'principal'
      else excluded.role
    end;

  update public.org_invitations set accepted_at = now() where id = v_inv.id;

  insert into public.audit_log (org_id, actor_id, action, target, metadata)
  values (v_inv.org_id, v_user, 'invitation.accepted', v_inv.id::text,
          jsonb_build_object('role', v_inv.role));

  return query select v_inv.org_id, v_inv.role;
end;
$$;

revoke all on function public.create_invitation(uuid, text, text) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.create_invitation(uuid, text, text) to authenticated, service_role;
grant execute on function public.accept_invitation(text) to authenticated, service_role;
