import type { Metadata } from "next";
import { SetupForm } from "./SetupForm";

export const metadata: Metadata = { title: "Set up your school" };

export default function SetupPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Set up your school</h1>
      <p className="text-muted">
        You will be the principal. Next you can invite teachers, who create classes and add their
        students.
      </p>
      <SetupForm />
    </div>
  );
}
