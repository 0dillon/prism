import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ServiceError } from "@/lib/api/http";
import { getClassroom } from "@/lib/classrooms/service";
import { createClient } from "@/lib/supabase/server";
import { countOf } from "@/renderers/shared/lesson";
import { ClassroomSettings } from "./ClassroomSettings";

export const metadata: Metadata = { title: "Class" };

export const dynamic = "force-dynamic";

export default async function ClassroomPage({ params }: PageProps<"/teach/classrooms/[id]">) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(`/sign-in?next=${encodeURIComponent(`/teach/classrooms/${id}`)}`);

  let classroom;
  try {
    classroom = await getClassroom(supabase, data.user.id, id);
  } catch (error) {
    if (error instanceof ServiceError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-1">
        <p>
          <Link href="/teach/classrooms" className="underline">
            All classes
          </Link>
        </p>
        <h1 className="text-3xl font-bold">{classroom.name}</h1>
        <p className="text-muted">
          {[
            classroom.grade && `Grade ${classroom.grade}`,
            classroom.subject,
            countOf(classroom.students, "student"),
          ]
            .filter(Boolean)
            .join(" · ")}
          {classroom.archived ? " · Archived" : ""}
        </p>
      </div>
      <ClassroomSettings classroom={classroom} />
    </div>
  );
}
