import "server-only";
import { prisma } from "@/lib/db";
import { getInstitute } from "@/lib/config";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { PERMISSIONS, hasAnyPermission } from "@/lib/permissions";
import { buildReport, reportDefinition, type ReportParams } from "@/lib/reports";
import { reportToCsv, reportToExcel, reportToPdf } from "@/lib/reports/export";
import { buildReceiptPdf, resolveReceiptNo } from "@/lib/receipt-pdf";
import { buildWelcomeKitPdf, loadWelcomeKit, welcomeKitFileName } from "@/lib/welcome-kit";
import type { Attachment } from "@/lib/notification-providers";
import type { NotificationKind } from "@/generated/prisma/client";

/**
 * Documents staff can email out: the welcome kit, a fee receipt, and any report
 * — the Student Ledger among them.
 *
 * Every document is **rebuilt here from its identifiers**. Nothing about the
 * file comes from the browser: no URL to fetch, no bytes to upload. That keeps
 * the emailed copy identical to the printed one, and means the permission check
 * below is the only way to obtain the document, exactly as for the routes that
 * serve it on screen.
 */

export type EmailableDocument =
  | { kind: "welcome-kit"; applicationId: string }
  | { kind: "receipt"; receiptId: string }
  | { kind: "report"; reportKey: string; query: ReportParams; format: "pdf" | "xlsx" | "csv" };

export type PreparedDocument = {
  attachment: Attachment;
  /** Which notification kind the send is logged under. */
  logKind: NotificationKind;
  subject: string;
  body: string;
  /** Best guess at the recipient, offered to staff and always editable. */
  suggestedTo: string | null;
  studentId?: string;
  applicationId?: string;
};

const FORMAT_TYPES = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
} as const;

function signOff(instituteName: string): string {
  return `\n\n— ${instituteName}`;
}

export async function prepareDocument(
  document: EmailableDocument,
  permissions: readonly string[],
): Promise<PreparedDocument> {
  const institute = await getInstitute();
  const instituteName = institute.name;

  if (document.kind === "welcome-kit") {
    if (!hasAnyPermission(permissions, [PERMISSIONS.ENROLLMENT_VIEW, PERMISSIONS.STUDENT_VIEW])) {
      throw new ForbiddenError();
    }
    const kit = await loadWelcomeKit(document.applicationId);
    if (!kit.ok) {
      throw kit.reason === "not-found"
        ? new NotFoundError("Application")
        : new ValidationError("The welcome kit is issued once the admission is approved and the student exists.");
    }

    const buffer = await buildWelcomeKitPdf(kit);
    return {
      attachment: {
        filename: welcomeKitFileName(kit.student.studentCode),
        content: buffer,
        contentType: FORMAT_TYPES.pdf,
      },
      logKind: "WELCOME",
      subject: `Welcome to ${instituteName} — admission confirmed (${kit.student.studentCode})`,
      body:
        `Dear ${kit.student.fullName},\n\n` +
        `Your admission is confirmed. Your Student ID is ${kit.student.studentCode}.\n\n` +
        "Attached is your welcome kit: the admission confirmation letter, your admission form, the year-wise fee " +
        "payment plan, the terms & conditions, and your registration fee receipt.\n\n" +
        "Please keep it for your records." +
        signOff(instituteName),
      suggestedTo: kit.student.email ?? kit.application.email ?? null,
      studentId: kit.student.id,
      applicationId: kit.application.id,
    };
  }

  if (document.kind === "receipt") {
    if (
      !hasAnyPermission(permissions, [
        PERMISSIONS.FEE_COLLECT,
        PERMISSIONS.REPORT_FEE_COLLECTION,
        PERMISSIONS.REPORT_LEDGER,
      ])
    ) {
      throw new ForbiddenError();
    }
    const receiptNo = await resolveReceiptNo(document.receiptId);
    if (!receiptNo) throw new NotFoundError("Receipt");
    const receipt = await buildReceiptPdf(receiptNo);
    if (!receipt) throw new NotFoundError("Receipt");

    return {
      attachment: {
        filename: receipt.fileName,
        content: receipt.buffer,
        contentType: FORMAT_TYPES.pdf,
      },
      logKind: "RECEIPT",
      subject: `Fee receipt ${receipt.receiptNo} — ${instituteName}`,
      body:
        `Dear ${receipt.payerName},\n\n` +
        `Please find attached fee receipt ${receipt.receiptNo}.\n\n` +
        "Keep it safe — it is the proof of payment the institute recognises." +
        signOff(instituteName),
      suggestedTo: receipt.payerEmail,
      studentId: receipt.studentId ?? undefined,
      applicationId: receipt.applicationId ?? undefined,
    };
  }

  // Reports, including the Student Ledger. `buildReport` performs the
  // per-report permission check and throws if this user may not see it.
  const definition = reportDefinition(document.reportKey);
  if (!definition) throw new NotFoundError("Report");

  const report = await buildReport(document.reportKey, document.query, permissions);
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${document.reportKey}-${stamp}`;

  const content =
    document.format === "pdf"
      ? await reportToPdf(report, institute)
      : document.format === "xlsx"
        ? await reportToExcel(report, institute)
        : Buffer.from(reportToCsv(report, institute), "utf-8");

  // A ledger is one student's account, so it has an obvious recipient; the other
  // reports are internal and get none.
  const ledgerStudent =
    document.reportKey === "ledger" && document.query.studentId
      ? await prisma.student.findUnique({
          where: { id: document.query.studentId },
          select: { id: true, email: true },
        })
      : null;

  return {
    attachment: {
      filename: `${base}.${document.format}`,
      content,
      contentType: FORMAT_TYPES[document.format],
    },
    logKind: "DOCUMENT",
    subject: `${report.title} — ${instituteName}`,
    body:
      `Please find attached: ${report.title}.\n\n` +
      (report.filterSummary.length ? `${report.filterSummary.join("\n")}\n\n` : "") +
      `Rows: ${report.rows.length}` +
      signOff(instituteName),
    suggestedTo: ledgerStudent?.email ?? null,
    studentId: ledgerStudent?.id,
  };
}
