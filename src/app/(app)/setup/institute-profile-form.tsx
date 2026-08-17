"use client";

import type { Institute } from "@/generated/prisma/client";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Card, Field, FormActions, FormGrid, Input } from "@/components/ui";
import { saveInstituteProfileAction } from "./actions";

export function InstituteProfileForm({ institute }: { institute: Institute | null }) {
  return (
    <ActionForm action={saveInstituteProfileAction}>
      {(state) => (
        <Card>
          <FormGrid>
            <Field label="Institute name" htmlFor="name" required error={fieldError(state, "name")} className="sm:col-span-2">
              <Input id="name" name="name" defaultValue={institute?.name ?? ""} required />
            </Field>
            <Field label="Address line 1" htmlFor="addressLine1" error={fieldError(state, "addressLine1")}>
              <Input id="addressLine1" name="addressLine1" defaultValue={institute?.addressLine1 ?? ""} />
            </Field>
            <Field label="Address line 2" htmlFor="addressLine2" error={fieldError(state, "addressLine2")}>
              <Input id="addressLine2" name="addressLine2" defaultValue={institute?.addressLine2 ?? ""} />
            </Field>
            <Field label="City" htmlFor="city" error={fieldError(state, "city")}>
              <Input id="city" name="city" defaultValue={institute?.city ?? ""} />
            </Field>
            <Field label="State" htmlFor="state" error={fieldError(state, "state")}>
              <Input id="state" name="state" defaultValue={institute?.state ?? ""} />
            </Field>
            <Field label="PIN code" htmlFor="pincode" error={fieldError(state, "pincode")}>
              <Input id="pincode" name="pincode" defaultValue={institute?.pincode ?? ""} inputMode="numeric" />
            </Field>
            <Field label="Contact email" htmlFor="contactEmail" error={fieldError(state, "contactEmail")}>
              <Input id="contactEmail" name="contactEmail" type="email" defaultValue={institute?.contactEmail ?? ""} />
            </Field>
            <Field label="Contact phone" htmlFor="contactPhone" error={fieldError(state, "contactPhone")}>
              <Input id="contactPhone" name="contactPhone" defaultValue={institute?.contactPhone ?? ""} />
            </Field>
            <Field label="Website" htmlFor="website" error={fieldError(state, "website")}>
              <Input id="website" name="website" defaultValue={institute?.website ?? ""} />
            </Field>
          </FormGrid>
          <FormActions>
            <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
          </FormActions>
        </Card>
      )}
    </ActionForm>
  );
}
