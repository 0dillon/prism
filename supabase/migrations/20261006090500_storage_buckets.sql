-- Private storage buckets (PRD 5.1, 6.4): sources and lesson-media.
--
-- Path conventions, enforced by the policies below:
--   sources:      {owner_id}/{lesson_id}/source.{ext}   readable and writable by the owner only
--   lesson-media: {lesson_id}/{file}                    writable by the lesson owner,
--                                                       readable by anyone entitled to the lesson
-- Neither bucket is public. Files are served through signed URLs of one hour or less.

-- Returns the uuid in a path segment, or null if it is not one. Policy expressions can
-- be evaluated in any order, so a bare cast could raise on an unexpected path.
create function public.try_uuid(p_text text) returns uuid
language plpgsql
immutable
as $$
begin
  return p_text::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

revoke all on function public.try_uuid(text) from public, anon;
grant execute on function public.try_uuid(text) to authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('sources', 'sources', false, 52428800), -- 50 MB, the upload limit in PRD CE-1
  ('lesson-media', 'lesson-media', false, 10485760)
on conflict (id) do nothing;

-- sources: owners work inside their own folder.
create policy sources_objects_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text);

create policy sources_objects_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text);

create policy sources_objects_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text);

create policy sources_objects_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'sources' and (storage.foldername(name))[1] = auth.uid()::text);

-- lesson-media: the lesson owner manages files, entitled learners read them.
create policy lesson_media_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'lesson-media'
    and public.is_entitled(auth.uid(), public.try_uuid((storage.foldername(name))[1]))
  );

create policy lesson_media_objects_insert_owner on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lesson-media'
    and public.owns_lesson(public.try_uuid((storage.foldername(name))[1]))
  );

create policy lesson_media_objects_update_owner on storage.objects
  for update to authenticated
  using (
    bucket_id = 'lesson-media'
    and public.owns_lesson(public.try_uuid((storage.foldername(name))[1]))
  )
  with check (
    bucket_id = 'lesson-media'
    and public.owns_lesson(public.try_uuid((storage.foldername(name))[1]))
  );

create policy lesson_media_objects_delete_owner on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'lesson-media'
    and public.owns_lesson(public.try_uuid((storage.foldername(name))[1]))
  );
