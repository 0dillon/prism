"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/schemas";
import { signInAction, signUpAction, type AuthFormState } from "../actions";

interface AuthFormProps {
  mode: "sign-in" | "sign-up";
  /** Where to go after success. Already validated as an on-site path. */
  next: string;
}

const initialState: AuthFormState = {};

export function AuthForm({ mode, next }: AuthFormProps) {
  const isSignUp = mode === "sign-up";
  const [state, formAction, pending] = useActionState(
    isSignUp ? signUpAction : signInAction,
    initialState,
  );
  const formRef = useRef<HTMLFormElement>(null);

  // After a failed submit, move focus to the first field with an error so keyboard and
  // screen reader users land on the problem. The field's error text is read with it.
  useEffect(() => {
    if (!state.errors) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="next" value={next} />

      {state.message ? (
        <p
          role={state.tone === "info" ? "status" : "alert"}
          className={`border-line flex items-start gap-2 rounded-md border p-3 font-medium ${
            state.tone === "info" ? "" : "text-danger"
          }`}
        >
          <span aria-hidden="true">{state.tone === "info" ? "ℹ" : "⚠"}</span>
          <span>{state.message}</span>
        </p>
      ) : null}

      {isSignUp ? (
        <TextField
          label="Your name"
          name="displayName"
          type="text"
          autoComplete="name"
          required
          defaultValue={state.values?.displayName}
          error={state.errors?.displayName}
        />
      ) : null}

      <TextField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        defaultValue={state.values?.email}
        error={state.errors?.email}
      />

      {isSignUp ? (
        <TextField
          label="Date of birth"
          name="birthDate"
          type="date"
          autoComplete="bday"
          required
          hint="We use this only to check whether a parent or guardian needs to agree first. We do not show it to anyone."
          defaultValue={state.values?.birthDate}
          error={state.errors?.birthDate}
        />
      ) : null}

      <TextField
        label="Password"
        name="password"
        type="password"
        autoComplete={isSignUp ? "new-password" : "current-password"}
        required
        hint={isSignUp ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
        error={state.errors?.password}
      />

      <Button type="submit" disabled={pending}>
        {pending
          ? isSignUp
            ? "Creating account…"
            : "Signing in…"
          : isSignUp
            ? "Create account"
            : "Sign in"}
      </Button>
    </form>
  );
}
