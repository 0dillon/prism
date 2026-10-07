-- Organization creation (PRD 5.8, P6-01). One call makes the organization, makes the
-- caller its principal, and writes the audit entry, so a half-created school cannot
-- exist. Runs as the signed-in user; the caller is read from the session, never passed in.

create function public.create_organization(p_name text, p_slug text) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_org uuid;
begin
  if v_user is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;

  insert into public.organizations (name, slug, created_by)
  values (trim(p_name), p_slug, v_user)
  returning id into v_org;

  insert into public.org_memberships (org_id, user_id, role)
  values (v_org, v_user, 'principal');

  insert into public.audit_log (org_id, actor_id, action, target)
  values (v_org, v_user, 'org.created', v_org::text);

  return v_org;
end;
$$;

revoke all on function public.create_organization(text, text) from public, anon;
grant execute on function public.create_organization(text, text) to authenticated, service_role;
