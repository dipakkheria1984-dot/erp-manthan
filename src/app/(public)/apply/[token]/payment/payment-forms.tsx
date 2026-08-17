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
 */
export function PaymentPanel({
  token,
  paymentUrl,
  upi,
  qrImageUrl,
  note,
  amountLabel,
  existing,
}: {
  token: string;
  paymentUrl: string | null;
  upi: { id: string; uri: string; qrSvg: string | null } | null;
  /** The institute's own uploaded QR. Preferred over anything generated. */
  qrImageUrl: string | null;
  note: string | null;
  amountLabel: string;
  existing: { reference: string; amount: string; paidOn: string } | null;
}) {
  return (
    <div className="space-y-6">
      {upi || qrImageUrl ? (
        <Card
          title="Pay by UPI"
          description={`${amountLabel} · scan the code with any UPI app, or tap the button if you are already on your phone.`}
        >
          {note ? <p className="mb-4 text-sm text-muted">{note}</p> : null}
          <div className="flex flex-wrap items-center gap-6">
            {qrImageUrl ? (
              // The institute's own code, served from this app rather than
              // generated, because the bank's is the one the bank honours.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrImageUrl}
                alt="Scan this QR code with your UPI app to pay the registration fee"
                className="h-56 w-56 shrink-0 rounded-md border border-border bg-white object-contain p-2"
              />
            ) : upi?.qrSvg ? (
              <div
                className="h-56 w-56 shrink-0 rounded-md border border-border bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: upi.qrSvg }}
              />
            ) : null}
            <div className="space-y-3">
              {upi ? (
                <div>
                  <p className="text-xs text-muted">UPI ID</p>
                  <p className="font-mono text-sm font-medium">{upi.id}</p>
                </div>
              ) : null}
              {upi ? <LinkButton href={upi.uri}>Open my UPI app</LinkButton> : null}
              <p className="max-w-xs text-xs text-muted">
                {upi
                  ? "The button works on a phone with a UPI app installed. On a computer, scan the code with your phone instead."
                  : "Scan the code with your phone's UPI app."}
              </p>
            </div>
          </div>
          <p className="mt-4 text-xs text-muted">
            Check the payee name and the amount in your UPI app before approving. Keep the UPI transaction ID or
            UTR it gives you — you will need it below.
          </p>
        </Card>
      ) : null}

      {paymentUrl ? (
        <Card
          title={upi || qrImageUrl ? "Or pay by card or netbanking" : "Pay the registration fee"}
          description={`${amountLabel} · you will be taken to the bank's secure page, which opens in a new tab.`}
        >
          {note && !upi && !qrImageUrl ? <p className="mb-4 text-sm text-muted">{note}</p> : null}
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
