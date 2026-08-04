"use client";

import { ActionForm, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Card, Checkbox, Field, FormActions, FormGrid, Input, Select } from "@/components/ui";
import { toDateInput } from "@/lib/dates";
import { saveStudentInfoAction } from "./actions";

export type StudentInfoValues = {
  id?: string;
  fullName: string;
  gender: string;
  dob: string | null;
  bloodGroup: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  nationalId: string | null;
  previousEnrollmentNo: string | null;
  previousInstitution: string | null;
  previousQualification: string | null;
  previousMarks: string | null;
  hasTransferCertificate: boolean;
};

/**
 * The admission form's own fields.
 *
 * The same form serves the enrollment wizard and the profile editor on an
 * enrolled student's record, which posts to its own action — the wizard writes
 * to a draft application, the editor corrects a live student. `action` and
 * `idFieldName` are all that differ.
 */
export function StudentInfoForm({
  values,
  submitLabel,
  action = saveStudentInfoAction,
  idFieldName = "id",
}: {
  values?: StudentInfoValues;
  submitLabel: string;
  action?: (prev: FormState, formData: FormData) => Promise<FormState>;
  idFieldName?: string;
}) {
  return (
    <ActionForm action={action} className="space-y-6">
      {(state) => (
        <>
          {values?.id ? <input type="hidden" name={idFieldName} value={values.id} /> : null}

          <Card title="Personal details">
            <FormGrid>
              <Field label="Full name" htmlFor="fullName" required error={fieldError(state, "fullName")}>
                <Input id="fullName" name="fullName" defaultValue={values?.fullName ?? ""} required />
              </Field>
              <Field label="Gender" htmlFor="gender" required error={fieldError(state, "gender")}>
                <Select id="gender" name="gender" defaultValue={values?.gender ?? ""} required>
                  <option value="">Select…</option>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                  <option value="OTHER">Other</option>
                </Select>
              </Field>
              <Field
                label="Date of birth"
                htmlFor="dob"
                hint="Optional — the application can be submitted and approved without it."
                error={fieldError(state, "dob")}
              >
                <Input id="dob" name="dob" type="date" defaultValue={toDateInput(values?.dob)} />
              </Field>
              <Field label="Blood group" htmlFor="bloodGroup" error={fieldError(state, "bloodGroup")}>
                <Input id="bloodGroup" name="bloodGroup" defaultValue={values?.bloodGroup ?? ""} placeholder="e.g. O+" />
              </Field>
            </FormGrid>
          </Card>

          <Card title="Contact details" description="At least a phone number or email is needed so fee reminders can reach the family.">
            <FormGrid>
              <Field label="Phone" htmlFor="phone" error={fieldError(state, "phone")}>
                <Input id="phone" name="phone" defaultValue={values?.phone ?? ""} placeholder="+91…" />
              </Field>
              <Field label="Email" htmlFor="email" error={fieldError(state, "email")}>
                <Input id="email" name="email" type="email" defaultValue={values?.email ?? ""} />
              </Field>
              <Field label="Address line 1" htmlFor="addressLine1" error={fieldError(state, "addressLine1")}>
                <Input id="addressLine1" name="addressLine1" defaultValue={values?.addressLine1 ?? ""} />
              </Field>
              <Field label="Address line 2" htmlFor="addressLine2" error={fieldError(state, "addressLine2")}>
                <Input id="addressLine2" name="addressLine2" defaultValue={values?.addressLine2 ?? ""} />
              </Field>
              <Field label="City" htmlFor="city" error={fieldError(state, "city")}>
                <Input id="city" name="city" defaultValue={values?.city ?? ""} />
              </Field>
              <Field label="State" htmlFor="state" error={fieldError(state, "state")}>
                <Input id="state" name="state" defaultValue={values?.state ?? ""} />
              </Field>
              <Field label="PIN code" htmlFor="pincode" error={fieldError(state, "pincode")}>
                <Input id="pincode" name="pincode" inputMode="numeric" defaultValue={values?.pincode ?? ""} />
              </Field>
            </FormGrid>
          </Card>

          <Card title="Identifiers">
            <FormGrid>
              <Field
                label="Aadhaar / national ID"
                htmlFor="nationalId"
                hint="Used for duplicate enrollment detection."
                error={fieldError(state, "nationalId")}
              >
                <Input id="nationalId" name="nationalId" defaultValue={values?.nationalId ?? ""} />
              </Field>
              <Field
                label="Previous enrollment no."
                htmlFor="previousEnrollmentNo"
                hint="For re-admissions."
                error={fieldError(state, "previousEnrollmentNo")}
              >
                <Input
                  id="previousEnrollmentNo"
                  name="previousEnrollmentNo"
                  defaultValue={values?.previousEnrollmentNo ?? ""}
                />
              </Field>
            </FormGrid>
          </Card>

          <Card title="Previous academic record">
            <FormGrid>
              <Field label="Last school / institution" htmlFor="previousInstitution" error={fieldError(state, "previousInstitution")}>
                <Input id="previousInstitution" name="previousInstitution" defaultValue={values?.previousInstitution ?? ""} />
              </Field>
              <Field label="Qualification" htmlFor="previousQualification" error={fieldError(state, "previousQualification")}>
                <Input
                  id="previousQualification"
                  name="previousQualification"
                  defaultValue={values?.previousQualification ?? ""}
                  placeholder="e.g. Class 12 (Science)"
                />
              </Field>
              <Field label="Marks / grade" htmlFor="previousMarks" error={fieldError(state, "previousMarks")}>
                <Input id="previousMarks" name="previousMarks" defaultValue={values?.previousMarks ?? ""} placeholder="e.g. 86%" />
              </Field>
              <div className="flex items-center gap-2 pt-7">
                <Checkbox
                  id="hasTransferCertificate"
                  name="hasTransferCertificate"
                  defaultChecked={values?.hasTransferCertificate ?? false}
                />
                <label htmlFor="hasTransferCertificate" className="text-sm">
                  Transfer certificate produced
                </label>
              </div>
            </FormGrid>
            <FormActions>
              <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
            </FormActions>
          </Card>
        </>
      )}
    </ActionForm>
  );
}
