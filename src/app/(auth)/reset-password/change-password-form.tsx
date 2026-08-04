"use client";

import { useActionState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { changePasswordAction } from "../actions";
import { FormFeedback, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Field, Input } from "@/components/ui";

export function ChangePasswordForm({ minLength, forced }: { minLength: number; forced: boolean }) {
  const router = useRouter();
  const [state, action] = useActionState<FormState, FormData>(changePasswordAction, null);

  useEffect(() => {
    if (state?.ok) {
      router.replace("/dashboard");
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={action} className="space-y-4">
      <FormFeedback state={state} />
      <Field label="Current password" htmlFor="currentPassword" required error={fieldError(state, "currentPassword")}>
        <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
      </Field>
      <Field
        label="New password"
        htmlFor="newPassword"
        required
        hint={`At least ${minLength} characters, with upper and lower case, a digit and a special character.`}
        error={fieldError(state, "newPassword")}
      >
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required />
      </Field>
      <Field label="Confirm new password" htmlFor="confirmPassword" required error={fieldError(state, "confirmPassword")}>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required />
      </Field>
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Save password</SubmitButton>
        {forced ? null : (
          <Link href="/dashboard" className="text-sm text-muted hover:underline">
            Cancel
          </Link>
        )}
      </div>
    </form>
  );
}
