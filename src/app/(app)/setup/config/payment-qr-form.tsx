"use client";

import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Alert, Field, Input } from "@/components/ui";
import { removePaymentQrAction, uploadPaymentQrAction } from "../actions";

/**
 * Upload of the institute's own payment QR.
 *
 * Its own form rather than a field on the configuration form, because a file
 * cannot be carried through that form's save and because replacing the image
 * should not require re-saving every other setting.
 */
export function PaymentQrForm({
  hasQr,
  fileName,
  version,
  shown,
}: {
  hasQr: boolean;
  fileName: string | null;
  version: number;
  /** Whether applicants currently see it — the switch lives on the settings form. */
  shown: boolean;
}) {
  return (
    <div className="space-y-4">
      {hasQr ? (
        <div className="flex flex-wrap items-start gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/payment-qr?v=${version}`}
            alt="The payment QR applicants are shown"
            className="h-40 w-40 rounded-md border border-border bg-white object-contain p-2"
          />
          <div className="space-y-2">
            <p className="text-sm">
              This is what applicants see on the registration fee step.
              {fileName ? <span className="block text-xs text-muted">{fileName}</span> : null}
            </p>
            <p className="text-xs text-muted">
              Scan it yourself with a UPI app before switching it on — the code is shown to applicants exactly
              as uploaded and this system cannot tell whether it resolves.
            </p>
            <p className="text-xs">
              {shown ? (
                <span className="text-success">Applicants can see this code.</span>
              ) : (
                <span className="text-muted">
                  Not shown to applicants yet — tick &ldquo;Show the QR to applicants&rdquo; in the settings above
                  and save.
                </span>
              )}
            </p>
            <ActionForm action={removePaymentQrAction} className="contents">
              <SubmitButton variant="ghost" size="sm" className="text-danger" pendingLabel="Removing…">
                Remove QR
              </SubmitButton>
            </ActionForm>
          </div>
        </div>
      ) : (
        <Alert tone="info">
          No QR uploaded. Upload the one your bank gave you — a code the bank issued is the one it will honour.
          Uploading does not publish it: applicants see it only once you switch it on above, so you can scan-test
          it first.
        </Alert>
      )}

      <ActionForm action={uploadPaymentQrAction}>
        {(state) => (
          <>
            <Field
              label={hasQr ? "Replace the QR image" : "Upload your payment QR"}
              htmlFor="paymentQr"
              hint="PNG, JPG or PDF. A PDF is converted to an image and trimmed to the code automatically."
              error={fieldError(state, "paymentQr")}
            >
              <Input id="paymentQr" name="paymentQr" type="file" accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf" />
            </Field>
            <SubmitButton variant="secondary" pendingLabel="Uploading…">
              {hasQr ? "Replace QR" : "Upload QR"}
            </SubmitButton>
          </>
        )}
      </ActionForm>
    </div>
  );
}
