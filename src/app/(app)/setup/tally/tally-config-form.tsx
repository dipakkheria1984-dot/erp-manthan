"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Checkbox, Field, FormActions, FormGrid, Input, Select } from "@/components/ui";
import { retryFailedTallyAction, saveTallyConfigAction } from "./actions";

export type TallyConfigValues = {
  enabled: boolean;
  companyName: string;
  voucherTypeName: string;
  syncFrom: string;
  ledgerUpi: string;
  ledgerCard: string;
  ledgerBankTransfer: string;
  ledgerCheque: string;
  ledgerOther: string;
  creditMode: "FIXED" | "STUDENT";
  feeLedger: string;
  registrationLedger: string;
  lateFeeLedger: string;
  studentLedgerGroup: string;
  sendBankAllocations: boolean;
};

const MODE_FIELDS = [
  { name: "ledgerUpi", label: "UPI", hint: "e.g. HDFC Bank A/c" },
  { name: "ledgerCard", label: "Card", hint: "e.g. Card Settlement A/c" },
  { name: "ledgerBankTransfer", label: "Bank transfer (NEFT/RTGS/IMPS)", hint: "e.g. HDFC Bank A/c" },
  { name: "ledgerCheque", label: "Cheque", hint: "e.g. Cheques in Hand or the bank" },
  { name: "ledgerOther", label: "Other", hint: "Leave blank to hold these back" },
] as const;

export function TallyConfigForm({ config }: { config: TallyConfigValues }) {
  const [creditMode, setCreditMode] = useState(config.creditMode);

  return (
    <ActionForm action={saveTallyConfigAction}>
      {(state) => (
        <>
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox name="enabled" defaultChecked={config.enabled} />
            Post non-cash receipts to Tally Prime automatically
          </label>

          <FormGrid cols={3}>
            <Field
              label="Tally company"
              htmlFor="companyName"
              hint="Exactly as named in Tally. Blank posts to whichever company is open."
              error={fieldError(state, "companyName")}
            >
              <Input id="companyName" name="companyName" defaultValue={config.companyName} />
            </Field>
            <Field
              label="Voucher type"
              htmlFor="voucherTypeName"
              required
              hint="Receipt, or a dedicated type such as “ERP Receipt”."
              error={fieldError(state, "voucherTypeName")}
            >
              <Input id="voucherTypeName" name="voucherTypeName" defaultValue={config.voucherTypeName} required />
            </Field>
            <Field
              label="Post receipts dated from"
              htmlFor="syncFrom"
              hint="Earlier receipts are never sent."
              error={fieldError(state, "syncFrom")}
            >
              <Input id="syncFrom" name="syncFrom" type="date" defaultValue={config.syncFrom} />
            </Field>
          </FormGrid>

          <div>
            <h3 className="text-sm font-semibold">Debit — bank ledger for each payment mode</h3>
            <p className="mt-0.5 text-xs text-muted">
              Cash is never posted. A mode left blank is held in the queue as failed until a ledger is set.
            </p>
          </div>
          <FormGrid cols={3}>
            {MODE_FIELDS.map((field) => (
              <Field key={field.name} label={field.label} htmlFor={field.name} hint={field.hint} error={fieldError(state, field.name)}>
                <Input id={field.name} name={field.name} defaultValue={config[field.name]} />
              </Field>
            ))}
          </FormGrid>

          <div>
            <h3 className="text-sm font-semibold">Credit — where the fee lands</h3>
          </div>
          <FormGrid cols={3}>
            <Field label="Credit to" htmlFor="creditMode" required>
              <Select
                id="creditMode"
                name="creditMode"
                value={creditMode}
                onChange={(event) => setCreditMode(event.target.value as "FIXED" | "STUDENT")}
              >
                <option value="FIXED">One fee ledger for all students</option>
                <option value="STUDENT">A ledger per student (created automatically)</option>
              </Select>
            </Field>
            {creditMode === "FIXED" ? (
              <Field label="Fee ledger" htmlFor="feeLedger" required error={fieldError(state, "feeLedger")}>
                <Input id="feeLedger" name="feeLedger" defaultValue={config.feeLedger} required />
              </Field>
            ) : (
              <>
                <input type="hidden" name="feeLedger" value={config.feeLedger} />
                <Field
                  label="Group for student ledgers"
                  htmlFor="studentLedgerGroup"
                  required
                  hint="Named “Student Name (Code)”."
                  error={fieldError(state, "studentLedgerGroup")}
                >
                  <Input id="studentLedgerGroup" name="studentLedgerGroup" defaultValue={config.studentLedgerGroup} required />
                </Field>
              </>
            )}
            {creditMode === "FIXED" ? (
              <input type="hidden" name="studentLedgerGroup" value={config.studentLedgerGroup} />
            ) : null}
            <Field
              label="Registration fee ledger"
              htmlFor="registrationLedger"
              required
              hint="Registration receipts taken before enrolment."
              error={fieldError(state, "registrationLedger")}
            >
              <Input id="registrationLedger" name="registrationLedger" defaultValue={config.registrationLedger} required />
            </Field>
            <Field
              label="Late fee ledger"
              htmlFor="lateFeeLedger"
              hint="Optional. Set it to credit late fees separately."
              error={fieldError(state, "lateFeeLedger")}
            >
              <Input id="lateFeeLedger" name="lateFeeLedger" defaultValue={config.lateFeeLedger} />
            </Field>
          </FormGrid>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="sendBankAllocations" defaultChecked={config.sendBankAllocations} />
            Send instrument details (UTR / cheque no.) for bank reconciliation
            <span className="text-muted">— needs banking details enabled on those ledgers in Tally</span>
          </label>

          <FormActions>
            <SubmitButton pendingLabel="Saving…">Save Tally settings</SubmitButton>
          </FormActions>
        </>
      )}
    </ActionForm>
  );
}

export function RetryFailedButton({ disabled }: { disabled: boolean }) {
  return (
    <ActionForm action={retryFailedTallyAction} className="space-y-2">
      <SubmitButton variant="secondary" size="sm" pendingLabel="Re-queuing…" disabled={disabled}>
        Retry failed
      </SubmitButton>
    </ActionForm>
  );
}
