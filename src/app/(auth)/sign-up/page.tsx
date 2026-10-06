import type { Metadata } from "next";
import Link from "next/link";
import { safeNextPath } from "@/lib/auth/paths";
import { AuthForm } from "../_components/AuthForm";

export const metadata: Metadata = { title: "Create an account" };

export default async function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  const { next } = await searchParams;
  const destination = safeNextPath(typeof next === "string" ? next : undefined);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Create an account</h1>
      <p className="text-muted">
        Prism never asks for a diagnosis or a disability. You choose how lessons look and sound.
      </p>
      <AuthForm mode="sign-up" next={destination} />
      <p>
        Already have an account?{" "}
        <Link
          href={`/sign-in?next=${encodeURIComponent(destination)}`}
          className="font-semibold underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
