import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listClassrooms } from "@/lib/classrooms/service";
import { listTeachingOrgs } from "@/lib/orgs/queries";
import { createClient } from "@/lib/supabase/server";
import { countOf } from "@/renderers/shared/lesson";
import { CreateClassroomForm } from "./CreateClassroomForm";

export const metadata: Metadata = { title: "My classes" };

export const dynamic = "force-dynamic";

export default async function ClassroomsPage({ searchParams }: PageProps<"/teach/classrooms">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/sign-in?next=%2Fteach%2Fclassrooms");

  const showArchived = (await searchParams).archived === "1";
  const [orgs, classrooms] = await Promise.all([
    listTeachingOrgs(supabase, data.user.id),
    listClassrooms(supabase, data.user.id, { archived: showArchived }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-3xl font-bold">{showArchived ? "Archived classes" : "My classes"}</h1>

      {classrooms.length === 0 ? (
        <p className="text-muted">
          {showArchived ? "You have no archived classes." : "You have no classes yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {classrooms.map((room) => (
            <li key={room.id} className="border-line flex flex-col gap-1 rounded-lg border p-4">
              <h2 className="text-xl font-semibold">
                <Link href={`/teach/classrooms/${room.id}`} className="underline">
                  {room.name}
                </Link>
              </h2>
              <p className="text-muted text-sm">
                {[
                  room.grade && `Grade ${room.grade}`,
                  room.subject,
                  countOf(room.students, "student"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p>
        <Link
          href={showArchived ? "/teach/classrooms" : "/teach/classrooms?archived=1"}
          className="underline"
        >
          {showArchived ? "Back to my classes" : "Show archived classes"}
        </Link>
      </p>

      {!showArchived ? (
        <section aria-labelledby="new-class-heading" className="flex flex-col gap-4">
          <h2 id="new-class-heading" className="text-xl font-semibold">
            Create a class
          </h2>
          {orgs.length === 0 ? (
            <p className="text-muted">
              You are not part of a school yet. Ask your principal to invite you, then accept the
              invitation to create classes.
            </p>
          ) : (
            <CreateClassroomForm orgs={orgs} />
          )}
        </section>
      ) : null}
    </div>
  );
}
