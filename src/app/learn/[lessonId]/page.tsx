import type { Metadata } from "next";
import { forbidden, notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ServiceError } from "@/lib/api/http";
import { getPublishedLesson } from "@/lib/lessons/publish-service";
import { createClient } from "@/lib/supabase/server";
import { LessonPlayer } from "./LessonPlayer";

export const metadata: Metadata = { title: "Lesson" };

// Always the latest published version, and never shared between learners.
export const dynamic = "force-dynamic";

export default async function LessonPage({ params }: PageProps<"/learn/[lessonId]">) {
  const { lessonId } = await params;
  if (!z.uuid().safeParse(lessonId).success) notFound();

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(`/sign-in?next=${encodeURIComponent(`/learn/${lessonId}`)}`);

  let lesson;
  try {
    lesson = await getPublishedLesson(supabase, lessonId);
  } catch (error) {
    // Row-level security hides lessons the user may not read, so "not found" here means
    // "not yours to see". Both get the same 403 page and reveal nothing about the lesson.
    if (error instanceof ServiceError && error.status === 404) forbidden();
    throw error;
  }

  return (
    <LessonPlayer
      lessonId={lesson.lessonId}
      graphVersion={lesson.graphVersion}
      graph={lesson.graph}
    />
  );
}
