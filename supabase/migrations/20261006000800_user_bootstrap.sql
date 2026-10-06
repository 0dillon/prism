-- Provision application rows when a Supabase Auth user is created.
--
-- Doing this with a trigger rather than from application code means there is no window in
-- which a signed-in user has no profile, and no need for any privileged provisioning path in
-- the backend at all. One less reason to reach for the service role is one less place a
-- service-role bug can live.
--
-- The default profile below duplicates the schema defaults in app/schemas/render_profile.py.
-- That duplication is deliberate - the database must be able to provision a user without the
-- application running - and it is drift-checked by a test that compares this row against
-- RenderProfile(), so the two cannot quietly diverge.

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users_public (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      split_part(coalesce(new.email, ''), '@', 1),
      ''
    )
  )
  on conflict (id) do nothing;

  insert into public.render_profiles (user_id, profile)
  values (new.id, private.default_render_profile())
  on conflict (user_id) do nothing;

  return new;
end
$$;

-- The `standard` preset, which is the schema defaults (PRD 5.3).
create or replace function private.default_render_profile()
returns jsonb
language sql
immutable
as $$
  select '{
    "schemaVersion": 1,
    "preset": "standard",
    "layout": "reader",
    "content": {
      "readingLevel": "original",
      "chunkSize": "section",
      "showExamples": true
    },
    "quiz": {
      "cadence": 5,
      "itemsPerCheck": 1,
      "retryOnWrong": true
    },
    "typography": {
      "font": "system",
      "sizeScale": 1.0,
      "letterSpacing": 0.0,
      "wordSpacing": 0.0,
      "lineHeight": 1.5,
      "maxLineLength": 70,
      "wordAnchors": false
    },
    "audio": {
      "readAloud": false,
      "syncHighlight": "off",
      "rate": 1.0,
      "voiceInput": false,
      "earcons": false
    },
    "visual": {
      "theme": "system",
      "reducedMotion": false,
      "captions": true,
      "signClips": false,
      "signLanguage": "ase",
      "conceptImages": false
    },
    "feedback": {
      "progressBar": true,
      "streaks": false,
      "celebration": "subtle",
      "haptics": false
    }
  }'::jsonb
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- Profile-sharing consent is audited (PRD 6.4, task P6-09).
--
-- In the trigger rather than in application code, so the record is written whichever path
-- changes the flag. The audit row records that consent changed and in which direction; it
-- does not copy the profile contents, which would turn the audit log into a second store of
-- exactly the sensitive data the flag protects.
-- ---------------------------------------------------------------------------
create or replace function private.audit_profile_sharing_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.share_with_teachers is distinct from old.share_with_teachers then
    insert into public.audit_log (actor_id, action, target, metadata)
    values (
      new.user_id,
      'profile_share_changed',
      'render_profiles:' || new.user_id::text,
      jsonb_build_object(
        'share_with_teachers', new.share_with_teachers,
        'previous', old.share_with_teachers
      )
    );
  end if;
  return new;
end
$$;

create or replace trigger render_profiles_audit_sharing
  after update on public.render_profiles
  for each row execute function private.audit_profile_sharing_change();

revoke all on function private.handle_new_user() from public;
revoke all on function private.audit_profile_sharing_change() from public;
grant execute on function private.default_render_profile() to authenticated, service_role;
