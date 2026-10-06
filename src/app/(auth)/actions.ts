"use server";

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth/paths";
import { fieldErrors, SignInInput, SignUpInput } from "@/lib/auth/schemas";
import { createClient } from "@/lib/supabase/server";

export interface AuthFormState {
  /** Per-field validation messages. */
  errors?: Partial<Record<string, string>>;
  /** A form-level message, for a failed sign-in or a confirmation notice. */
  message?: string;
  /** "error" for failures, "info" for notices such as "check your email". */
  tone?: "error" | "info";
  /** Values to put back in the form after a failed submit. Never includes the password. */
  values?: { email?: string; displayName?: string };
}

const SERVICE_DOWN = "We could not reach the sign-in service. Please try again in a moment.";

/** True when the failure is the service being unreachable or erroring, not the user's input. */
function isServiceFailure(error: { status?: number }): boolean {
  return isAuthRetryableFetchError(error) || (error.status ?? 0) >= 500;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function signInAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const values = { email: text(formData, "email") };
  const parsed = SignInInput.safeParse({
    email: values.email,
    password: text(formData, "password"),
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    if (isServiceFailure(error)) return { message: SERVICE_DOWN, tone: "error", values };
    // One message for every credential failure so the form does not reveal which emails exist.
    return { message: "That email and password do not match.", tone: "error", values };
  }
  redirect(safeNextPath(text(formData, "next")));
}

export async function signUpAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const values = { email: text(formData, "email"), displayName: text(formData, "displayName") };
  const parsed = SignUpInput.safeParse({ ...values, password: text(formData, "password") });
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };

  const next = safeNextPath(text(formData, "next"));
  const origin = (await headers()).get("origin") ?? "";
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { display_name: parsed.data.displayName },
      emailRedirectTo: `${origin}/auth/confirm?next=${encodeURIComponent(next)}`,
    },
  });

  if (error) {
    if (isServiceFailure(error)) return { message: SERVICE_DOWN, tone: "error", values };
    return {
      message: "We could not create that account. Check your details and try again.",
      tone: "error",
      values,
    };
  }
  if (!data.session) {
    // Email confirmation is on: the account exists but cannot sign in until confirmed.
    return {
      message: "Check your email for a link to confirm your account.",
      tone: "info",
      values: { email: values.email },
    };
  }
  redirect(next);
}
