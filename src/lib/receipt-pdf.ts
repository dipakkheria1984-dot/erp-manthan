import "server-only";
import { prisma } from "@/lib/db";
import { getInstitute, getInstituteLogo } from "@/lib/config";
import { termsInForce } from "@/lib/terms";
import { createDocument, drawCutLine, toBuffer } from "@/lib/pdf";
import { resolvePrintStyle } from "@/lib/print-theme";
import { RECEIPT_COPIES, drawReceiptCopy, loadReceiptLines } from "@/lib/pdf-sections";

/**
 * Fee receipt PDF (spec 10.2).
 *
 * Printed as two copies on a single A4 sheet — the student keeps the top half,
 * the office files the bottom — with a cut line between them. Both carry the
 * receipt terms & conditions in force on the payment date, which are separate
 * from the terms printed on the admission form.
 *
 * Lives here rather than in the route so that emailing a receipt attaches the
 * identical document the counter prints, instead of a second rendering that
 * could quietly drift from it.
 */

/** Gap left around the cut line so scissors do not take a line of text with them. */
const CUT_GUTTER = 24;

export type ReceiptPdf = {
  buffer: Buffer;
  fileName: string;
  receiptNo: string;
  /** Who the receipt is for, so callers can default an email recipient. */
  studentId: string | null;
  applicationId: string | null;
  payerName: string;
  payerEmail: string | null;
};

/** Resolves `id` as either a payment id or a receipt number. */
export async function resolveReceiptNo(id: string): Promise<string | null> {
  const matched = await prisma.payment.findFirst({
    where: { OR: [{ id }, { receiptNo: id }] },
    select: { receiptNo: true },
  });
  return matched?.receiptNo ?? null;
}

export async function buildReceiptPdf(receiptNo: string): Promise<ReceiptPdf | null> {
  const lines = await loadReceiptLines(receiptNo);
  if (lines.length === 0) return null;

  const payment = lines[0];
  const [institute, terms] = await Promise.all([
    getInstitute(),
    termsInForce("RECEIPT", payment.paymentDate),
  ]);

  const doc = createDocument({
    title: `Receipt ${payment.receiptNo}`,
    style: resolvePrintStyle(institute),
    logo: await getInstituteLogo(institute),
  });

  const top = doc.page.margins.top;
  const usable = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  const copyHeight = (usable - CUT_GUTTER) / 2;

  RECEIPT_COPIES.forEach((copyLabel, index) => {
    const copyTop = top + index * (copyHeight + CUT_GUTTER);
    drawReceiptCopy(doc, { lines, institute, terms, copyLabel, top: copyTop, height: copyHeight });
    if (index === 0) drawCutLine(doc, copyTop + copyHeight + CUT_GUTTER / 2);
  });

  return {
    buffer: await toBuffer(doc),
    fileName: `receipt-${payment.receiptNo}.pdf`,
    receiptNo: payment.receiptNo,
    studentId: payment.studentId,
    applicationId: payment.applicationId,
    payerName: payment.student?.fullName ?? payment.application?.fullName ?? "—",
    payerEmail: payment.student?.email ?? payment.application?.email ?? null,
  };
}
