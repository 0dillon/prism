-- Sign links are proposed during review, before the lesson is published, but the
-- normalized concepts rows only exist after publish. Links are therefore keyed by the
-- graph's stable concept id without a foreign key. A link whose concept was deleted is
-- harmless: learners only ever join links to concepts that exist in the published graph.

alter table public.concept_sign_links
  drop constraint concept_sign_links_lesson_id_concept_id_fkey;

alter table public.concept_sign_links
  add constraint concept_sign_links_lesson_fk
  foreign key (lesson_id) references public.lessons (id) on delete cascade;
