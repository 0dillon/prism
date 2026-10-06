import { z } from "zod";

/** Validation for the sign-in and sign-up forms. Messages are shown to the user. */

export const MIN_PASSWORD_LENGTH = 8;

const email = z
  .string()
  .trim()
  .min(1, "Enter your email address.")
  .pipe(z.email("Enter a valid email address."));

export const SignInInput = z.object({
  email,
  password: z.string().min(1, "Enter your password."),
});
export type SignInInput = z.infer<typeof SignInInput>;

export const SignUpInput = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Enter your name.")
    .max(60, "Use 60 characters or fewer for your name."),
  email,
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`)
    .max(72, "Use 72 characters or fewer for your password."),
});
export type SignUpInput = z.infer<typeof SignUpInput>;

export type FieldErrors<T extends string> = Partial<Record<T, string>>;

/** Flattens a Zod error to the first message for each field. */
export function fieldErrors<T extends string>(error: z.ZodError): FieldErrors<T> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors as FieldErrors<T>;
}
