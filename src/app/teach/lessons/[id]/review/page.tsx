import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { createClient } from "@/lib/supabase/server";
import { ReviewEditor } from "./ReviewEditor";

export const metadata: Metadata = { title: "Review lesson" };

// The editor always shows the latest saved draft.
export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: PageProps<"/teach/lessons/[id]/review">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(`/sign-in?next=${encodeURIComponent(`/teach/lessons/${id}/review`)}`);

  const { data: lesson } = await supabase
    .from("lessons")
    .select("id, owner_id, title, status, graph, updated_at")
    .eq("id", id)
    .maybeSingle();
  // A lesson the user cannot see and one they do not own look the same.
  if (!lesson || lesson.owner_id !== auth.user.id) notFound();

  const message = (heading: string, body: string, action?: { href: string; label: string }) => (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{heading}</h1>
      <p>{body}</p>
      {action ? (
        <p>
          <Link href={action.href} className="font-semibold underline">
            {action.label}
          </Link>
        </p>
      ) : null}
    </div>
  );

  if (lesson.status === "uploading" || lesson.status === "processing") {
    return message(
      "This lesson is still being processed",
      "Prism is still reading the file. Come back when it is ready for review.",
      { href: "/teach/upload", label: "Back to upload" },
    );
  }
  if (lesson.status === "failed") {
    return message(
      "This lesson could not be processed",
      "Something went wrong while reading the file. You can try uploading it again.",
      { href: "/teach/upload", label: "Upload again" },
    );
  }
  if (lesson.status === "published") {
    return message(
      "This lesson is published",
      "Published lessons cannot be edited yet. Editing a published lesson is coming soon.",
    );
  }

  const graph = KnowledgeGraph.safeParse(lesson.graph);
  if (!graph.success) {
    return message(
      "This lesson's draft could not be opened",
      "The draft is damaged. Please upload the file again.",
      { href: "/teach/upload", label: "Upload again" },
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-12">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Review: {graph.data.title}</h1>
        <p className="text-muted mt-2 max-w-3xl">
          Check what Prism extracted from your file. Edit anything that is wrong, then save.
          Learners see nothing until you publish.
        </p>
      </div>
      <ReviewEditor
        lessonId={lesson.id}
        initialGraph={graph.data}
        initialUpdatedAt={lesson.updated_at}
      />
    </div>
  );
}
