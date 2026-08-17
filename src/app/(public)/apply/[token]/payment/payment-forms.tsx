"use client";

import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Card, Field, FormActions, FormGrid, Input, LinkButton } from "@/components/ui";
import { savePortalPaymentClaimAction } from "../../actions";

/**
 * Sends the applicant to the bank's page, then takes down what they say
 * happened there.
 *
 * The two halves are deliberately separate. Opening the link proves nothing —
 * the bank tells this system nothing at all — so the reference is typed back in
 * by hand and travels onward marked as unverified.
 */
export function PaymentPanel({
  token,
  paymentUrl,
  note,
  amountLabel,
  existing,
}: {
  token: string;
  paymentUrl: string;
  note: string | null;
  amountLabel: string;
  existing: { reference: string; amount: string; paidOn: string } | null;
}) {
  return (
    <div className="space-y-6">
      <Card
        title="Pay the registration fee"
        description={`${amountLabel} · you will be taken to the bank's secure page, which opens in a new tab.`}
      >
        {note ? <p className="mb-4 text-sm text-muted">{note}</p> : null}
        <LinkButton href={paymentUrl} target="_blank" rel="noreferrer noopener">
          Open the payment page
        </LinkButton>
        <p className="mt-3 text-xs text-muted">
          Keep the reference or transaction number the bank shows you — you will need it below. Never share your
          card details, UPI PIN or one-time password with anyone from the institute; the bank&rsquo;s page is the
          only place they should ever be entered.
        </p>
      </Card>

      <Card
        title="Tell us what you paid"
        description="Enter the reference the bank gave you. The office checks it against the bank statement before confirming."
      >
        <ActionForm action={savePortalPaymentClaimAction}>
          {(state) => (
            <>
              <input type="hidden" name="token" value={token} />
              <FormGrid>
                <Field
                  label="Payment reference / transaction number"
                  htmlFor="reference"
                  required
                  error={fieldError(state, "reference")}
                >
                  <Input id="reference" name="reference" defaultValue={existing?.reference ?? ""} required />
                </Field>
                <Field label="Amount paid (₹)" htmlFor="amount" required error={fieldError(state, "amount")}>
                  <Input
                    id="amount"
                    name="amount"
                    inputMode="decimal"
                    defaultValue={existing?.amount ?? ""}
                    required
                  />
                </Field>
                <Field label="Date paid" htmlFor="paidOn" error={fieldError(state, "paidOn")}>
                  <Input id="paidOn" name="paidOn" type="date" defaultValue={existing?.paidOn ?? ""} />
                </Field>
              </FormGrid>
              <FormActions>
                <SubmitButton pendingLabel="Saving…">
                  {existing ? "Update payment details" : "Save payment details"}
                </SubmitButton>
              </FormActions>
            </>
          )}
        </ActionForm>
      </Card>
    </div>
  );
}
