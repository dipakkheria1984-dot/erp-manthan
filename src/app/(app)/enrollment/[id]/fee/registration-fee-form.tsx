"use client";

import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Field, FormActions, FormGrid, Input, Select } from "@/components/ui";
import { toDateInput } from "@/lib/dates";
import { recordRegistrationFeeAction } from "../../actions";

export function RegistrationFeeForm({ applicationId }: { applicationId: string }) {
  return (
    <ActionForm action={recordRegistrationFeeAction} resetOnSuccess>
      {(state) => (
        <>
          <input type="hidden" name="applicationId" value={applicationId} />
          <FormGrid cols={3}>
            <Field label="Amount (₹)" htmlFor="amountPaise" required error={fieldError(state, "amountPaise")}>
              <Input id="amountPaise" name="amountPaise" inputMode="decimal" required />
            </Field>
            <Field label="Payment date" htmlFor="paymentDate" required error={fieldError(state, "paymentDate")}>
              <Input id="paymentDate" name="paymentDate" type="date" defaultValue={toDateInput(new Date())} required />
            </Field>
            <Field label="Mode" htmlFor="mode" required error={fieldError(state, "mode")}>
              <Select id="mode" name="mode" defaultValue="CASH">
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CHEQUE">Cheque</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
            <Field
              label="Transaction reference"
              htmlFor="referenceNo"
              hint="UTR, cheque no. or gateway reference."
              error={fieldError(state, "referenceNo")}
            >
              <Input id="referenceNo" name="referenceNo" />
            </Field>
            <Field label="Remarks" htmlFor="remarks" error={fieldError(state, "remarks")} className="sm:col-span-2">
              <Input id="remarks" name="remarks" />
            </Field>
          </FormGrid>
          <FormActions>
            <SubmitButton pendingLabel="Recording…">Record payment</SubmitButton>
          </FormActions>
        </>
      )}
    </ActionForm>
  );
}
