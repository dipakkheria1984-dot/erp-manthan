"use client";

import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Alert, Card, Field, FormActions, FormGrid, Input, LinkButton } from "@/components/ui";
import { savePortalPaymentClaimAction } from "../../actions";

/**
 * Sends the applicant to the bank's page, then takes down what they say
 * happened there.
 *
 * The two halves are deliberately separate. Opening the link proves nothing —
 * the bank tells this system nothing at all — so the reference is typed back in
 * by hand and travels onward marked as unverified.
 *
 * Paying by UPI deep link is parked: it did not work in practice, so applicants
 * see the hosted page and, once the institute switches it on, the QR its bank
 * issued.
 */
export function PaymentPanel({
  token,
  paymentUrl,
  qrImageUrl,
  note,
  amountLabel,
  existing,
}: {
  token: string;
  paymentUrl: string | null;
  /** The institute's own uploaded QR, once switched on. Never generated. */
  qrImageUrl: string | null;
  note: string | null;
  amountLabel: string;
  existing: { reference: string; amount: string; paidOn: string } | null;
}) {
  return (
    <div className="space-y-6">
      {qrImageUrl ? (
        <Card
          title="Pay by UPI"
          description={`${amountLabel} · scan this code with any UPI app on your phone.`}
        >
          {note ? <p className="mb-4 text-sm text-muted">{note}</p> : null}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qrImageUrl}
            alt="Scan this QR code with your UPI app to pay the registration fee"
            className="h-56 w-56 rounded-md border border-border bg-white object-contain p-2"
          />
          <p className="mt-4 text-xs text-muted">
            Check the payee name and the amount in your UPI app before approving. Keep the transaction ID or UTR
            it gives you — you will need it below.
          </p>
        </Card>
      ) : null}

      {paymentUrl ? (
        <Card
          title={qrImageUrl ? "Or pay by card or netbanking" : "Pay the registration fee"}
          description={`${amountLabel} · you will be taken to the bank's secure page, which opens in a new tab.`}
        >
          {note && !qrImageUrl ? <p className="mb-4 text-sm text-muted">{note}</p> : null}
          <LinkButton href={paymentUrl} target="_blank" rel="noreferrer noopener">
            Open the payment page
          </LinkButton>
          <p className="mt-3 text-xs text-muted">
            Keep the reference or transaction number the bank shows you — you will need it below.
          </p>
        </Card>
      ) : null}

      <Alert tone="warning" title="Nobody from the institute will ever ask for your PIN">
        Your UPI PIN, card CVV and one-time passwords are entered only in your own bank or UPI app. No member of
        staff will ask you for them, by phone or otherwise, and this form never asks for them.
      </Alert>

      <Card
        title="Please confirm your transaction number and amount"
        description="Enter them exactly as your UPI app or bank showed them. The office checks both against the statement before confirming."
      >
        <ActionForm action={savePortalPaymentClaimAction}>
          {(state) => (
            <>
              <input type="hidden" name="token" value={token} />
              <FormGrid>
                <Field
                  label="UPI transaction ID / UTR / bank reference"
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
