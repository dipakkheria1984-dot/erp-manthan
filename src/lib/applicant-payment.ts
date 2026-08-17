import "server-only";

/**
 * Whether the applicant will meet a payment step at all.
 *
 * One answer shared by the landing page, the step navigation, the documents
 * step's onward link and the payment step itself — they each used to work it
 * out, and a form that offers a fee step while its own blurb says nothing is
 * payable is exactly the contradiction that produces.
 *
 * An uploaded QR only counts once it has been switched on: uploading one is
 * how it gets scan-tested, not how it gets published.
 */
export function paymentIsOffered(config: {
  registrationPaymentUrl: string | null;
  paymentQrStoragePath: string | null;
  paymentQrEnabled: boolean;
}): boolean {
  return Boolean(config.registrationPaymentUrl) || Boolean(config.paymentQrStoragePath && config.paymentQrEnabled);
}
