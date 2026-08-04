import "server-only";
import { prisma, type Db } from "@/lib/db";
import { formatDate } from "@/lib/dates";
import { formatPaisePdf } from "@/lib/money";
import {
  FONT,
  applyFontFor,
  drawCompactHeader,
  drawFieldRows,
  drawSignatureRow,
  drawTable,
  drawTermsBlock,
  paletteOf,
  sectionHeading,
  type PdfDoc,
  type PrintableTerms,
} from "@/lib/pdf";
import type { Institute, Prisma } from "@/generated/prisma/client";

/**
 * Document bodies that appear in more than one PDF.
 *
 * The admission form and the fee receipt are each served on their own route and
 * are *also* bound into the welcome kit (src/lib/welcome-kit.ts). Keeping the
 * drawing here means the copy handed to the family is the same document the
 * office prints, rather than a second rendering that quietly drifts.
 *
 * Each `draw*Body` covers the content between the letterhead and the footer —
 * callers own `drawHeader`, `drawTerms` and `drawFooter` so they can decide page
 * breaks and which terms version applies.
 */

/* -------------------------------------------------------------------------- */
/* Admission form                                                              */
/* -------------------------------------------------------------------------- */

export const ADMISSION_FORM_INCLUDE = {
  guardians: true,
  documents: true,
  department: true,
  course: true,
  batch: true,
  academicYear: true,
  student: { select: { studentCode: true, enrollmentDate: true } },
} satisfies Prisma.ApplicationInclude;

export type AdmissionFormApplication = Prisma.ApplicationGetPayload<{ include: typeof ADMISSION_FORM_INCLUDE }>;

export function loadAdmissionForm(applicationId: string, db: Db = prisma): Promise<AdmissionFormApplication | null> {
  return db.application.findUnique({ where: { id: applicationId }, include: ADMISSION_FORM_INCLUDE });
}

/** Title case for the single-word enums printed on forms (`MALE` → `Male`). */
function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export function fullAddress(source: {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
}): string {
  return (
    [source.addressLine1, source.addressLine2, source.city, source.state, source.pincode]
      .filter(Boolean)
      .join(", ") || "—"
  );
}

export function drawAdmissionFormBody(doc: PdfDoc, application: AdmissionFormApplication): void {
  sectionHeading(doc, "Student details");
  doc.moveDown(0.3);
  drawFieldRows(doc, [
    ["Full name", application.fullName],
    ["Date of birth", formatDate(application.dob)],
    ["Gender", titleCase(application.gender)],
    ["Blood group", application.bloodGroup ?? "—"],
    ["Phone", application.phone ?? "—"],
    ["Email", application.email ?? "—"],
    ["Address", fullAddress(application)],
    ["National ID", application.nationalId ?? "—"],
    ["Previous institution", application.previousInstitution ?? "—"],
    ["Previous marks", application.previousMarks ?? "—"],
  ]);

  sectionHeading(doc, "Admission details");
  doc.moveDown(0.3);
  drawFieldRows(doc, [
    ["Academic year", application.academicYear?.name ?? "—"],
    ["Department", application.department?.name ?? "—"],
    ["Course", application.course?.name ?? "—"],
    ["Batch", application.batch?.name ?? "—"],
    ["Status", application.status.replaceAll("_", " ").toLowerCase()],
    ["Student ID", application.student?.studentCode ?? "—"],
    ["Registration fee paid", formatPaisePdf(application.registrationFeePaidPaise)],
    ["Enrollment date", formatDate(application.student?.enrollmentDate)],
  ]);

  if (application.guardians.length > 0) {
    sectionHeading(doc, "Parent / guardian");
    doc.moveDown(0.3);
    drawTable(
      doc,
      [
        { header: "Relationship", width: 90 },
        { header: "Name", width: 140 },
        { header: "Occupation", width: 110 },
        { header: "Phone", width: 95 },
        { header: "Email", width: 80 },
      ],
      application.guardians.map((guardian) => [
        titleCase(guardian.relation),
        guardian.name,
        guardian.occupation ?? "—",
        guardian.phone ?? "—",
        guardian.email ?? "—",
      ]),
    );
    doc.moveDown(0.5);
  }

  if (application.documents.length > 0) {
    sectionHeading(doc, "Documents submitted");
    doc.moveDown(0.3);
    drawTable(
      doc,
      [
        { header: "Document", width: 240 },
        { header: "File", width: 175 },
        { header: "Status", width: 100 },
      ],
      application.documents.map((document) => [document.label, document.fileName, document.status.toLowerCase()]),
    );
  }

  drawSignatureRow(doc, "Signature of applicant / guardian", "For the institute");
}

/* -------------------------------------------------------------------------- */
/* Fee receipt                                                                 */
/* -------------------------------------------------------------------------- */

export const PAYMENT_MODE_LABEL: Record<string, string> = {
  CASH: "Cash",
  UPI: "UPI",
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  CHEQUE: "Cheque",
  OTHER: "Other",
};

const RECEIPT_INCLUDE = {
  student: { include: { course: true, batch: true, department: true } },
  application: true,
  collectedBy: { select: { name: true } },
  cancelledBy: { select: { name: true } },
  installment: { include: { feeAssignment: { include: { semester: true } } } },
} satisfies Prisma.PaymentInclude;

export type ReceiptLine = Prisma.PaymentGetPayload<{ include: typeof RECEIPT_INCLUDE }>;

/**
 * Every row sharing a receipt number, earliest first. One collection can be
 * spread over several installments (FIFO), so a receipt number owns one row per
 * installment the money reached.
 */
export function loadReceiptLines(receiptNo: string, db: Db = prisma): Promise<ReceiptLine[]> {
  return db.payment.findMany({
    where: { receiptNo },
    include: RECEIPT_INCLUDE,
    orderBy: { receiptSeq: "asc" },
  });
}

/** The two copies every fee receipt is printed in (student keeps one, office files the other). */
export const RECEIPT_COPIES = ["Student copy", "Office copy"] as const;

/**
 * One complete receipt drawn inside a fixed vertical band, so two copies share a
 * page. Everything — letterhead, details, particulars, terms — is confined to
 * `height`; the terms are ellipsed rather than allowed to overrun the copy
 * below, and nothing here ever starts a new page.
 */
export function drawReceiptCopy(
  doc: PdfDoc,
  {
    lines,
    institute,
    terms,
    copyLabel,
    top,
    height,
  }: {
    lines: ReceiptLine[];
    institute: Institute;
    terms: PrintableTerms | null;
    copyLabel: string;
    top: number;
    height: number;
  },
): void {
  const palette = paletteOf(doc);
  const payment = lines[0];
  const totalPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);
  const totalLateFeePaise = lines.reduce((sum, line) => sum + line.lateFeePortionPaise, 0);
  const bottom = top + height;

  doc.y = top;
  drawCompactHeader(doc, institute, "FEE RECEIPT", {
    subtitle: payment.status === "CANCELLED" ? "*** CANCELLED / VOID ***" : undefined,
    copyLabel,
  });

  drawFieldRows(
    doc,
    [
      ["Receipt no.", payment.receiptNo],
      ["Date", formatDate(payment.paymentDate)],
      ["Payment mode", PAYMENT_MODE_LABEL[payment.mode] ?? payment.mode],
      ["Reference", payment.referenceNo ?? "—"],
      ["Student / applicant", payment.student?.fullName ?? payment.application?.fullName ?? "—"],
      ["ID", payment.student?.studentCode ?? payment.application?.applicationNo ?? "—"],
      ["Course", payment.student?.course.name ?? "—"],
      ["Batch", payment.student?.batch.name ?? "—"],
    ],
    { columns: 4, compact: true },
  );

  const particularsFor = (line: ReceiptLine) =>
    line.kind === "REGISTRATION"
      ? "Registration / admission fee"
      : `Installment ${line.installment?.seqNo ?? "—"} — semester ${
          line.installment?.feeAssignment.semester.semesterNumber ?? "—"
        }${line.installment ? ` (due ${formatDate(line.installment.dueDate)})` : ""}`;

  drawTable(
    doc,
    [
      { header: "Particulars", width: 390 },
      { header: "Amount", width: 125, align: "right" },
    ],
    [
      ...lines.map((line) => [particularsFor(line), formatPaisePdf(line.amountPaise - line.lateFeePortionPaise)]),
      ...(totalLateFeePaise > 0 ? [["Late fee", formatPaisePdf(totalLateFeePaise)]] : []),
      ["Total received", formatPaisePdf(totalPaise)],
    ],
  );

  doc.moveDown(0.3);
  const collectedBy = `Collected by: ${payment.collectedBy?.name ?? "—"}${
    payment.remarks ? ` · ${payment.remarks}` : ""
  }`;
  applyFontFor(doc, collectedBy).fontSize(7.5).fillColor(palette.ink).text(collectedBy);

  if (payment.status === "CANCELLED") {
    const cancelledLine = `Cancelled on ${formatDate(payment.cancelledAt)} by ${
      payment.cancelledBy?.name ?? "—"
    } · Reason: ${payment.cancellationReason ?? "—"}`;
    // Never themed: a void receipt has to read as void whatever the palette.
    doc.fillColor(palette.alert);
    applyFontFor(doc, cancelledLine, "bold").fontSize(7.5).text(cancelledLine);
    doc.fillColor(palette.ink);
  }

  // Signature sits at a fixed offset from the foot of the band so both copies
  // line up, whatever the particulars ran to.
  const signatureY = bottom - 16;
  const termsRoom = signatureY - doc.y - 14;
  if (termsRoom > 0) {
    doc.moveDown(0.4);
    drawTermsBlock(doc, terms, { maxHeight: Math.min(termsRoom, signatureY - doc.y), size: 5.5 });
  }

  const signature = "Authorised signatory";
  doc.font(FONT.body).fontSize(7).fillColor(palette.muted);
  const right = doc.page.width - doc.page.margins.right;
  doc.text("__________________", right - 120, signatureY - 10, { width: 120, align: "right" });
  applyFontFor(doc, signature).fontSize(6.5).fillColor(palette.ink).text(signature, right - 120, signatureY + 1, {
    width: 120,
    align: "right",
  });
  doc.x = doc.page.margins.left;
}
