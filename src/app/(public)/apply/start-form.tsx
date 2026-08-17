"use client";

import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Card, Field, FormActions, FormGrid, Input, Select } from "@/components/ui";
import { startApplicationAction } from "./actions";

/**
 * Just enough to create the application and send the applicant their link.
 *
 * The full personal details come on the next screen, once there is a record to
 * save them against — asking for everything here would mean losing the lot if
 * the page were closed before it was submitted.
 */
export function StartForm() {
  return (
    <ActionForm action={startApplicationAction}>
      {(state) => (
        <Card
          title="Start your application"
          description="We will send you a private link so you can come back and finish this later."
        >
          <FormGrid>
            <Field label="Full name" htmlFor="fullName" required error={fieldError(state, "fullName")}>
              <Input id="fullName" name="fullName" required autoComplete="name" />
            </Field>
            <Field label="Gender" htmlFor="gender" required error={fieldError(state, "gender")}>
              <Select id="gender" name="gender" defaultValue="" required>
                <option value="">Select…</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
            <Field label="Mobile number" htmlFor="phone" error={fieldError(state, "phone")}>
              <Input id="phone" name="phone" autoComplete="tel" placeholder="+91…" />
            </Field>
            <Field
              label="Email"
              htmlFor="email"
              hint="Give a phone number or an email — your form link is sent to both."
              error={fieldError(state, "email")}
            >
              <Input id="email" name="email" type="email" autoComplete="email" />
            </Field>
          </FormGrid>
          <FormActions>
            <SubmitButton pendingLabel="Starting…">Start my application</SubmitButton>
          </FormActions>
        </Card>
      )}
    </ActionForm>
  );
}
