import "server-only";
import QRCode from "qrcode";

/**
 * UPI collection for the registration fee.
 *
 * A UPI ID is a destination, not an integration. Money pushed to a static VPA
 * arrives in the bank account and nowhere else — no callback, no webhook, no
 * way for this system to learn it happened. So everything here is convenience
 * for the payer, and the payment is still recorded as a claim the office checks
 * against the statement. See `Application.claimedPayment*`.
 *
 * What it does buy is two fewer ways to get the payment wrong: on a phone the
 * deep link opens the payer's UPI app with the payee and amount already filled
 * in, and on a desktop the same string as a QR is scannable from that phone.
 */

/** Roughly what NPCI accepts: `name@handle`, both sides alphanumeric-ish. */
const VPA = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/;

export function isValidUpiId(value: string): boolean {
  return VPA.test(value.trim());
}

/**
 * The `upi://pay` URI, per the NPCI deep-link spec.
 *
 * `am` is the quoted amount and `tn` the note the payee sees on the statement.
 * Some apps drop or truncate the note, so it is a reconciliation aid and never
 * the thing the office matches on — that is the reference the applicant types
 * back afterwards.
 */
export function upiPaymentUri({
  upiId,
  payeeName,
  amountPaise,
  note,
}: {
  upiId: string;
  payeeName: string;
  amountPaise: number;
  note?: string;
}): string {
  const params = new URLSearchParams({
    pa: upiId.trim(),
    pn: payeeName,
    // UPI expects rupees with two decimals, not paise.
    am: (amountPaise / 100).toFixed(2),
    cu: "INR",
  });
  // Apps vary in how much of the note survives; keep it short enough to stand a
  // chance of arriving intact.
  if (note) params.set("tn", note.slice(0, 50));

  // URLSearchParams encodes spaces as "+", which some UPI apps show literally
  // in the payee name. %20 is understood everywhere.
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * The same URI as an inline SVG, so the page carries no external image request
 * and nothing about the payment leaves the applicant's browser to a third party.
 */
export async function upiQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, {
    type: "svg",
    margin: 1,
    // Medium recovery: a printed or screen-shown code stays readable with a
    // little dirt on it without inflating the pattern.
    errorCorrectionLevel: "M",
  });
}
