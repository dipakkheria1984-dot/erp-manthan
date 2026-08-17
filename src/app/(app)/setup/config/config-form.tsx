"use client";

import type { InstituteConfig } from "@/generated/prisma/client";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Alert, Card, Checkbox, Field, FormActions, FormGrid, Input } from "@/components/ui";
import { toDateInput } from "@/lib/dates";
import { paiseToRupees } from "@/lib/money";
import { saveConfigAction } from "../actions";
import { OnlineAdmissionsLink } from "./online-admissions-link";

export function ConfigForm({ config }: { config: InstituteConfig }) {
  const rupees = (paise: number) => String(paiseToRupees(paise));

  return (
    <ActionForm action={saveConfigAction} className="space-y-6">
      {(state) => (
        <>
          <Card title="Student identity" description="How Student IDs are composed on approval.">
            <FormGrid cols={3}>
              <Field label="Student ID prefix" htmlFor="studentIdPrefix" required error={fieldError(state, "studentIdPrefix")}>
                <Input id="studentIdPrefix" name="studentIdPrefix" defaultValue={config.studentIdPrefix} required />
              </Field>
              <Field
                label="LF No. length"
                htmlFor="lfNoLength"
                required
                hint="Digits the LF No. is padded to."
                error={fieldError(state, "lfNoLength")}
              >
                <Input id="lfNoLength" name="lfNoLength" type="number" min={3} max={10} defaultValue={config.lfNoLength} required />
              </Field>
              <Field
                label="Next LF No."
                htmlFor="lfNoNext"
                required
                hint="The next number that will be issued."
                error={fieldError(state, "lfNoNext")}
              >
                <Input id="lfNoNext" name="lfNoNext" type="number" min={1} defaultValue={config.lfNoNext} required />
              </Field>
            </FormGrid>
          </Card>

          <Card title="Admission & scholarship">
            <Alert tone="warning" title="Hidden from staff">
              The scholarship auto-approval threshold is never shown on Registrar or Admission Staff screens. Staff only
              see a generic “this discount requires Admin approval” message when they exceed it.
            </Alert>
            <div className="mt-4">
              <FormGrid cols={2}>
                <Field
                  label="Minimum registration fee (₹)"
                  htmlFor="minRegistrationFeePaise"
                  required
                  hint="Gates Draft → Submitted. Partial or full payment is accepted above this floor."
                  error={fieldError(state, "minRegistrationFeePaise")}
                >
                  <Input
                    id="minRegistrationFeePaise"
                    name="minRegistrationFeePaise"
                    inputMode="decimal"
                    defaultValue={rupees(config.minRegistrationFeePaise)}
                    required
                  />
                </Field>
                <Field
                  label="Scholarship auto-approval threshold (%)"
                  htmlFor="scholarshipAutoApprovePercent"
                  required
                  hint="Discounts at or below this are auto-approved; above it the application is routed to Under Review."
                  error={fieldError(state, "scholarshipAutoApprovePercent")}
                >
                  <Input
                    id="scholarshipAutoApprovePercent"
                    name="scholarshipAutoApprovePercent"
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={config.scholarshipAutoApprovePercent}
                    required
                  />
                </Field>
              </FormGrid>
            </div>
          </Card>

          <Card title="Installments & late fees">
            <FormGrid cols={2}>
              <Field label="Minimum installments" htmlFor="installmentMin" required error={fieldError(state, "installmentMin")}>
                <Input id="installmentMin" name="installmentMin" type="number" min={1} max={60} defaultValue={config.installmentMin} required />
              </Field>
              <Field label="Maximum installments" htmlFor="installmentMax" required error={fieldError(state, "installmentMax")}>
                <Input id="installmentMax" name="installmentMax" type="number" min={1} max={60} defaultValue={config.installmentMax} required />
              </Field>
              <Field
                label="Late fee grace period (days)"
                htmlFor="lateFeeGraceDays"
                required
                hint="No penalty is charged within this window after the due date."
                error={fieldError(state, "lateFeeGraceDays")}
              >
                <Input id="lateFeeGraceDays" name="lateFeeGraceDays" type="number" min={0} defaultValue={config.lateFeeGraceDays} required />
              </Field>
              <Field
                label="Minimum outstanding threshold (₹)"
                htmlFor="minOutstandingThresholdPaise"
                required
                hint="No late fee applies when the remaining balance is at or below this."
                error={fieldError(state, "minOutstandingThresholdPaise")}
              >
                <Input
                  id="minOutstandingThresholdPaise"
                  name="minOutstandingThresholdPaise"
                  inputMode="decimal"
                  defaultValue={rupees(config.minOutstandingThresholdPaise)}
                  required
                />
              </Field>
              <Field
                label="Late fees calculated from"
                htmlFor="lateFeeEffectiveFrom"
                hint="Nothing accrues for time before this date, however long an installment has been overdue. Set it to forgive everything up to a day and start the policy there; leave it blank to charge from every due date."
                error={fieldError(state, "lateFeeEffectiveFrom")}
              >
                <Input
                  id="lateFeeEffectiveFrom"
                  name="lateFeeEffectiveFrom"
                  type="date"
                  defaultValue={toDateInput(config.lateFeeEffectiveFrom)}
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <Alert tone="info">
                Changing this re-prices every unpaid installment the next time it is read — how overdue a student is
                does not change, only what they are charged for it. Late fees already collected are untouched; those
                are handed back one at a time from the student&apos;s record.
              </Alert>
            </div>
          </Card>

          <Card title="Reminder cadence" description="Email and WhatsApp are always sent together for every reminder.">
            <FormGrid cols={2}>
              <Field label="Pre-due reminder (days before)" htmlFor="preDueReminderDays" required error={fieldError(state, "preDueReminderDays")}>
                <Input id="preDueReminderDays" name="preDueReminderDays" type="number" min={0} defaultValue={config.preDueReminderDays} required />
              </Field>
              <Field
                label="Overdue reminder interval (days)"
                htmlFor="overdueReminderIntervalDays"
                required
                hint="Repeats at this interval after the due date until the installment is paid."
                error={fieldError(state, "overdueReminderIntervalDays")}
              >
                <Input
                  id="overdueReminderIntervalDays"
                  name="overdueReminderIntervalDays"
                  type="number"
                  min={1}
                  defaultValue={config.overdueReminderIntervalDays}
                  required
                />
              </Field>
            </FormGrid>
          </Card>

          <Card
            title="Online admissions"
            description="Publishes a public admission form applicants can fill in themselves. They stop after uploading their documents — the batch, fee plan and registration fee stay with the office."
          >
            <div className="flex items-center gap-2">
              <Checkbox
                id="onlineAdmissionsEnabled"
                name="onlineAdmissionsEnabled"
                defaultChecked={config.onlineAdmissionsEnabled}
              />
              <label htmlFor="onlineAdmissionsEnabled" className="text-sm">
                Accept applications through the public link
              </label>
            </div>

            <div className="mt-4">
              <OnlineAdmissionsLink enabled={config.onlineAdmissionsEnabled} />
            </div>

            <FormGrid cols={2}>
              <Field
                label="New applications per hour, per visitor"
                htmlFor="onlineAdmissionsPerHour"
                required
                hint="Anyone with the address can start an application, so the rate is capped."
                error={fieldError(state, "onlineAdmissionsPerHour")}
              >
                <Input
                  id="onlineAdmissionsPerHour"
                  name="onlineAdmissionsPerHour"
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={config.onlineAdmissionsPerHour}
                  required
                />
              </Field>
              <Field
                label="Applicant link valid for (days)"
                htmlFor="onlineAdmissionsLinkDays"
                required
                hint="How long an applicant can keep coming back to finish their form."
                error={fieldError(state, "onlineAdmissionsLinkDays")}
              >
                <Input
                  id="onlineAdmissionsLinkDays"
                  name="onlineAdmissionsLinkDays"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={config.onlineAdmissionsLinkDays}
                  required
                />
              </Field>
            </FormGrid>

            <div className="mt-6 border-t border-border pt-4">
              <p className="text-sm font-medium">How applicants pay the registration fee</p>
              <p className="mt-1 text-sm text-muted">
                Applicants are sent to your bank&rsquo;s hosted page and asked to type back the reference it
                gives them. Leave it blank to collect at the counter only. A QR can be added below.
              </p>
              <div className="mt-3">
                <Alert tone="warning" title="Payment does not confirm itself">
                  Money paid on the bank&rsquo;s page, or scanned from a QR, arrives in your account and tells
                  this system nothing at all. A reported payment is therefore the applicant&rsquo;s word:
                  no receipt is issued, no money is recorded, and the admission stays provisional until your
                  office checks the reference against the statement and records the collection on the
                  application&rsquo;s Registration fee tab.
                </Alert>
              </div>
              <div className="mt-4">
                <FormGrid cols={1}>
                  <Field
                    label="Payment page address"
                    htmlFor="registrationPaymentUrl"
                    hint="Must start with https://"
                    error={fieldError(state, "registrationPaymentUrl")}
                  >
                    <Input
                      id="registrationPaymentUrl"
                      name="registrationPaymentUrl"
                      type="url"
                      placeholder="https://…"
                      defaultValue={config.registrationPaymentUrl ?? ""}
                    />
                  </Field>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="paymentQrEnabled"
                      name="paymentQrEnabled"
                      defaultChecked={config.paymentQrEnabled}
                    />
                    <label htmlFor="paymentQrEnabled" className="text-sm">
                      Show the QR to applicants (upload it below first)
                    </label>
                  </div>
                  <Field
                    label="Instructions shown to the applicant"
                    htmlFor="registrationPaymentNote"
                    hint="Optional — which reference to quote, what the payment covers."
                    error={fieldError(state, "registrationPaymentNote")}
                  >
                    <Input
                      id="registrationPaymentNote"
                      name="registrationPaymentNote"
                      defaultValue={config.registrationPaymentNote ?? ""}
                    />
                  </Field>
                </FormGrid>
              </div>
            </div>
          </Card>

          <Card title="Document numbering">
            <FormGrid cols={4}>
              <Field label="Receipt prefix" htmlFor="receiptPrefix" required error={fieldError(state, "receiptPrefix")}>
                <Input id="receiptPrefix" name="receiptPrefix" defaultValue={config.receiptPrefix} required />
              </Field>
              <Field label="Receipt digits" htmlFor="receiptPadding" required error={fieldError(state, "receiptPadding")}>
                <Input id="receiptPadding" name="receiptPadding" type="number" min={1} max={12} defaultValue={config.receiptPadding} required />
              </Field>
              <Field label="Application prefix" htmlFor="applicationPrefix" required error={fieldError(state, "applicationPrefix")}>
                <Input id="applicationPrefix" name="applicationPrefix" defaultValue={config.applicationPrefix} required />
              </Field>
              <Field label="Application digits" htmlFor="applicationPadding" required error={fieldError(state, "applicationPadding")}>
                <Input
                  id="applicationPadding"
                  name="applicationPadding"
                  type="number"
                  min={1}
                  max={12}
                  defaultValue={config.applicationPadding}
                  required
                />
              </Field>
            </FormGrid>
          </Card>

          <Card title="Password & login policy">
            <FormGrid cols={3}>
              <Field label="Minimum password length" htmlFor="passwordMinLength" required error={fieldError(state, "passwordMinLength")}>
                <Input id="passwordMinLength" name="passwordMinLength" type="number" min={6} max={64} defaultValue={config.passwordMinLength} required />
              </Field>
              <Field label="Failed attempts before lockout" htmlFor="maxFailedLoginAttempts" required error={fieldError(state, "maxFailedLoginAttempts")}>
                <Input
                  id="maxFailedLoginAttempts"
                  name="maxFailedLoginAttempts"
                  type="number"
                  min={1}
                  max={20}
                  defaultValue={config.maxFailedLoginAttempts}
                  required
                />
              </Field>
              <Field label="Lockout duration (minutes)" htmlFor="lockoutMinutes" required error={fieldError(state, "lockoutMinutes")}>
                <Input id="lockoutMinutes" name="lockoutMinutes" type="number" min={1} max={1440} defaultValue={config.lockoutMinutes} required />
              </Field>
            </FormGrid>
            <FormActions>
              <SubmitButton pendingLabel="Saving…">Save configuration</SubmitButton>
            </FormActions>
          </Card>
        </>
      )}
    </ActionForm>
  );
}
