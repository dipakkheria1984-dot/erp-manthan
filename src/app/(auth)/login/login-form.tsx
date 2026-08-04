"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { loginAction } from "../actions";
import { FormFeedback, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Field, Input } from "@/components/ui";

export function LoginForm() {
  const router = useRouter();
  const [state, action] = useActionState<FormState, FormData>(loginAction, null);

  useEffect(() => {
    if (state?.ok) {
      const { mustReset } = state.data as { mustReset: boolean };
      router.replace(mustReset ? "/reset-password" : "/dashboard");
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={action} className="space-y-4">
      <FormFeedback state={state} />
      <Field label="Email" htmlFor="email" required error={fieldError(state, "email")}>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password" required error={fieldError(state, "password")}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
