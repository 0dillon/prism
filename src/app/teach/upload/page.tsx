import type { Metadata } from "next";
import { UploadForm } from "./UploadForm";

export const metadata: Metadata = { title: "Upload a lesson" };

export default function UploadPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Upload a lesson</h1>
      <p className="text-muted">
        Upload your material once. Prism reads it, drafts the key ideas and quiz questions, and
        gives you a chance to review everything before any learner sees it.
      </p>
      <UploadForm />
    </div>
  );
}
