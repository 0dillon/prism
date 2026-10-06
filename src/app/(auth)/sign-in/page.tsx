import type { Metadata } from "next";
import Link from "next/link";
import { safeNextPath } from "@/lib/auth/paths";
import { AuthForm } from "../_components/AuthForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next, error } = await searchParams;
  const destination = safeNextPath(typeof next === "string" ? next : undefined);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
      {error === "confirm" ? (
        <p
          role="alert"
          className="border-line text-danger flex items-start gap-2 rounded-md border p-3 font-medium"
        >
          <span aria-hidden="true">⚠</span>
          <span>
            That confirmation link did not work. It may have expired. Try signing in, or create the
            account again.
          </span>
        </p>
      ) : null}
      <AuthForm mode="sign-in" next={destination} />
      <p>
        New to Prism?{" "}
        <Link
          href={`/sign-up?next=${encodeURIComponent(destination)}`}
          className="font-semibold underline"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}
