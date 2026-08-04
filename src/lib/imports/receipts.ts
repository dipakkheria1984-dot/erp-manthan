import "server-only";
import { prisma, type Db } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { endOfDay, formatDate } from "@/lib/dates";
import { allocateFifo, refreshInstallment } from "@/lib/late-fees";
import { settleProvisionalAdmission } from "@/lib/enrollment";
import { recordAuditTx } from "@/lib/audit";
import { formatSequence, nextSequenceValue, SEQ } from "@/lib/sequence";
import {
  mapHeaders,
  parseDate,
  parseRupees,
  readGrid,
  text,
  type ImportColumn,
  type ImportIssue,
} from "@/lib/imports/grid";
import type { Installment, Payment, PaymentMode } from "@/generated/prisma/client";

/**
 * Bulk import of receipt entries — money already collected in the old system,
 * or a batch of collections captured offline.
 *
 * Each row behaves exactly like one collection on the Collect Fees screen: the
 * amount settles installments oldest-due-first, clearing any late fee on an
 * installment before its principal, and the whole collection shares one receipt
 * number (spec 3.1).
 *
 * The awkward part is the preview. Several rows in one file can pay the same
 * student, so validating each row against the database in isolation would tell
 * the Admin every row fits when together they overshoot. Instead the preview
 * keeps a running in-memory copy of each student's installments and applies each
 * allocation to it, so what it reports is what the commit will do.
 */

/**
 * The headers match the collection register the institute exports — ID, Name,
 * Receipt No., Payment Mode, Amount Paid (Rs), Paid Date — so that file imports
 * as it comes. The older header names are kept as aliases, so files built from
 * an earlier template still work.
 */
export const RECEIPT_COLUMNS: ImportColumn[] = [
  {
    key: "studentCode",
    header: "ID",
    aliases: ["Student ID", "Student Code", "Student"],
    required: true,
    help: "The student's ID, e.g. IIFD-KOL-00009. The LF No on its own is accepted too.",
  },
  {
    key: "studentName",
    header: "Name",
    aliases: ["Student Name"],
    help: "Checked against the name on record. A mismatch is a warning, not a rejection — the ID decides who is paid for.",
  },
  {
    key: "receiptNo",
    header: "Receipt No.",
    aliases: ["Receipt No", "Receipt Number", "Receipt"],
    help: "The old system's receipt number, kept as-is. Left blank, the next number in this system's sequence is used.",
  },
  {
    key: "mode",
    header: "Payment Mode",
    aliases: ["Mode"],
    required: true,
    help: "Cash, UPI, Card Swipe, Credit/Debit Card, NEFT/RTGS/IMPS, Cheque/PDC/DD No. or Other.",
  },
  {
    key: "amount",
    header: "Amount Paid (Rs)",
    aliases: ["Amount", "Amount Paid", "Amount (Rs)"],
    required: true,
    help: "Amount collected, in rupees.",
  },
  {
    key: "paymentDate",
    header: "Paid Date",
    aliases: ["Payment Date", "Date"],
    required: true,
    help: "DD/MM/YYYY or YYYY-MM-DD.",
  },
  { key: "referenceNo", header: "Reference No", help: "UPI reference, cheque number, transaction ID." },
  { key: "remarks", header: "Remarks", help: "Free text, printed on the receipt." },
];

/**
 * Keyed by the mode text with everything but letters stripped, so "NEFT/RTGS",
 * "NEFT / RTGS" and "neft-rtgs" all land on the same entry. The institute's
 * register uses compound labels ("Cheque/PDC/DD No.", "Credit/Debit Card"),
 * which is why the combinations are spelled out rather than matched loosely —
 * a substring match would let "Card Swipe" and "Cash" collide with each other.
 */
const MODES: Record<string, PaymentMode> = {
  cash: "CASH",
  upi: "UPI",
  card: "CARD",
  cardswipe: "CARD",
  swipe: "CARD",
  creditdebitcard: "CARD",
  debitcreditcard: "CARD",
  creditcard: "CARD",
  debitcard: "CARD",
  banktransfer: "BANK_TRANSFER",
  bank: "BANK_TRANSFER",
  netbanking: "BANK_TRANSFER",
  neft: "BANK_TRANSFER",
  rtgs: "BANK_TRANSFER",
  imps: "BANK_TRANSFER",
  neftrtgs: "BANK_TRANSFER",
  neftrtgsimps: "BANK_TRANSFER",
  neftimps: "BANK_TRANSFER",
  rtgsimps: "BANK_TRANSFER",
  cheque: "CHEQUE",
  check: "CHEQUE",
  dd: "CHEQUE",
  pdc: "CHEQUE",
  chequedd: "CHEQUE",
  chequepdc: "CHEQUE",
  chequepdcdd: "CHEQUE",
  chequepdcddno: "CHEQUE",
  other: "OTHER",
  misc: "OTHER",
};

/** Case, spacing and punctuation differ freely between registers; nothing else does. */
function normaliseName(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

export type ResolvedReceipt = {
  studentId: string;
  studentCode: string;
  amountPaise: number;
  paymentDate: Date;
  mode: PaymentMode;
  /** Null when the sequence should assign one at commit time. */
  receiptNo: string | null;
  referenceNo: string | null;
  remarks: string | null;
  /** What the preview worked out this money would settle. */
  allocations: { installmentId: string; amountPaise: number; lateFeePortionPaise: number }[];
};

export type ReceiptRow = {
  rowNumber: number;
  /** Cells for the preview table: Receipt, Student, Name, Date, Amount, Settles. */
  display: string[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
  resolved?: ResolvedReceipt;
};

export type ReceiptPreview = {
  fileName: string;
  storagePath: string;
  totalRows: number;
  validRows: number;
  rows: ReceiptRow[];
  fatal: string[];
  totalPaise: number;
};

type WorkingInstallment = Installment & { payments: Payment[] };

export async function prepareReceiptImport(
  storagePath: string,
  fileName: string,
  db: Db = prisma,
): Promise<ReceiptPreview> {
  const grid = await readGrid(storagePath);
  const base: ReceiptPreview = {
    fileName,
    storagePath,
    totalRows: 0,
    validRows: 0,
    rows: [],
    fatal: [],
    totalPaise: 0,
  };

  if (grid.length === 0) return { ...base, fatal: ["The file has no rows."] };

  const index = mapHeaders(grid[0], RECEIPT_COLUMNS);
  if (index.size === 0) {
    return { ...base, fatal: ["None of the column headers were recognised. Download the template and use its header row."] };
  }
  const missing = RECEIPT_COLUMNS.filter((c) => c.required && !index.has(c.key));
  if (missing.length > 0) {
    return { ...base, fatal: [`Missing required column(s): ${missing.map((c) => c.header).join(", ")}.`] };
  }

  const [slabs, config] = await Promise.all([
    db.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
    getConfig(db),
  ]);

  const parsed = grid.slice(1).map((cells, i) => ({
    rowNumber: i + 2,
    get: (key: string) => text(cells[index.get(key) ?? -1]),
  }));

  // Rows are applied in payment-date order per student so late fees are assessed
  // as they actually accrued. Original row numbers are kept for the messages.
  const order = [...parsed.keys()].sort((a, b) => {
    const dateA = parseDate(parsed[a].get("paymentDate") ?? undefined);
    const dateB = parseDate(parsed[b].get("paymentDate") ?? undefined);
    const timeA = dateA instanceof Date ? dateA.getTime() : Number.MAX_SAFE_INTEGER;
    const timeB = dateB instanceof Date ? dateB.getTime() : Number.MAX_SAFE_INTEGER;
    return timeA === timeB ? a - b : timeA - timeB;
  });

  const rowsByIndex = new Map<number, ReceiptRow>();
  const workingByStudent = new Map<string, WorkingInstallment[]>();
  const exemptByStudent = new Map<string, boolean>();
  const seenReceiptNos = new Set<string>();
  let totalPaise = 0;

  for (const position of order) {
    const { rowNumber, get } = parsed[position];
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];

    const studentRef = get("studentCode");
    let student: {
      id: string;
      studentCode: string;
      status: string;
      applicationId: string;
      isProvisional: boolean;
      fullName: string;
    } | null = null;

    if (!studentRef) {
      errors.push({ field: "studentCode", message: "Student ID is required." });
    } else {
      const lfNo = Number(studentRef.replace(/[,\s]/g, ""));
      const found = await db.student.findFirst({
        where: {
          OR: [
            { studentCode: { equals: studentRef, mode: "insensitive" } },
            ...(Number.isInteger(lfNo) ? [{ lfNo }] : []),
          ],
        },
        select: {
          id: true,
          studentCode: true,
          status: true,
          applicationId: true,
          application: { select: { isProvisional: true, fullName: true } },
        },
      });
      if (!found) {
        errors.push({ field: "studentCode", message: `No student with ID or LF No "${studentRef}".` });
      } else if (found.status !== "ACTIVE" && found.status !== "PASSED") {
        errors.push({
          field: "studentCode",
          message: `${found.studentCode} is ${found.status.toLowerCase().replace("_", "-")}, so their pending fees have been waived.`,
        });
      } else {
        student = {
          ...found,
          isProvisional: found.application.isProvisional,
          fullName: found.application.fullName,
        };
      }
    }

    // The Name column is there so a mis-keyed ID is obvious before the money is
    // written. It never decides who is paid for — the ID does — so a difference
    // is only worth a warning.
    const nameInFile = get("studentName");
    if (student && nameInFile && normaliseName(nameInFile) !== normaliseName(student.fullName)) {
      warnings.push({
        field: "studentName",
        message: `${student.studentCode} is ${student.fullName} on record, not "${nameInFile}". The ID was used.`,
      });
    }

    const amount = parseRupees(get("amount") ?? undefined);
    if (amount === null) errors.push({ field: "amount", message: "Amount is required." });
    else if (amount === "invalid") errors.push({ field: "amount", message: "Amount must be a number." });
    // Registers carry 0-value lines for receipts raised without money changing
    // hands. Nothing can be allocated, so the row is skipped rather than failed.
    else if (amount === 0) errors.push({ field: "amount", message: "Amount is 0, so there is nothing to collect." });
    else if (amount < 0) errors.push({ field: "amount", message: "Amount must be a positive number." });

    const paymentDate = parseDate(get("paymentDate") ?? undefined);
    if (paymentDate === null) errors.push({ field: "paymentDate", message: "Payment Date is required." });
    else if (paymentDate === "invalid") errors.push({ field: "paymentDate", message: "Payment Date is not a valid date." });
    // A forward-dated payment is assessed against a later late-fee slab, which
    // silently changes which installments the money settles.
    else if (paymentDate > endOfDay(new Date())) {
      errors.push({ field: "paymentDate", message: "Payment Date is in the future." });
    }

    const modeRaw = get("mode");
    const mode = modeRaw ? MODES[modeRaw.toLowerCase().replace(/[^a-z]/g, "")] : undefined;
    if (!modeRaw) errors.push({ field: "mode", message: "Mode is required." });
    else if (!mode) {
      errors.push({
        field: "mode",
        message: `Payment Mode "${modeRaw}" is not one this system records — use Cash, UPI, Card Swipe, Credit/Debit Card, NEFT/RTGS/IMPS, Cheque/PDC/DD No. or Other.`,
      });
    }

    const receiptNo = get("receiptNo");
    if (receiptNo) {
      if (seenReceiptNos.has(receiptNo.toUpperCase())) {
        errors.push({ field: "receiptNo", message: `Receipt number ${receiptNo} appears more than once in this file.` });
      } else {
        const clash = await db.payment.findFirst({ where: { receiptNo }, select: { id: true } });
        if (clash) errors.push({ field: "receiptNo", message: `Receipt number ${receiptNo} is already used in this system.` });
      }
    }

    let allocations: ResolvedReceipt["allocations"] = [];

    if (student && typeof amount === "number" && paymentDate instanceof Date && mode && errors.length === 0) {
      let working = workingByStudent.get(student.id);
      if (!working) {
        working = (await db.installment.findMany({
          where: { feeAssignment: { studentId: student.id } },
          include: { payments: true },
          orderBy: [{ dueDate: "asc" }, { seqNo: "asc" }],
        })) as WorkingInstallment[];
        workingByStudent.set(student.id, working);
        exemptByStudent.set(student.id, student.isProvisional);
      }

      const amountPaise = rupeesToPaise(amount);
      const result = allocateFifo({
        installments: working,
        amountPaise,
        slabs,
        config,
        asOf: paymentDate,
        lateFeeExempt: exemptByStudent.get(student.id) ?? false,
      });

      if (working.length === 0) {
        // The commonest reason a migrated student takes no money: the fee plan
        // has not been assigned, so there are no installments to settle.
        errors.push({
          field: "studentCode",
          message: `${student.studentCode} has no fee plan assigned, so there are no installments for this money to settle. Assign the fee plan first.`,
        });
      } else if (result.allocations.length === 0) {
        errors.push({
          field: "amount",
          message: `${student.studentCode} has nothing outstanding left to collect against — earlier rows in this file may already have settled it.`,
        });
      } else if (result.unallocatedPaise > 0) {
        const collectable = amountPaise - result.unallocatedPaise;
        errors.push({
          field: "amount",
          message:
            `${formatPaise(amountPaise)} is more than ${student.studentCode} owes at this point in the file. ` +
            `The most that can be collected here is ${formatPaise(collectable)}.`,
        });
      } else {
        allocations = result.allocations;
        // Fold the allocation into the working copy so later rows for this
        // student see the reduced balance.
        for (const allocation of allocations) {
          const installment = working.find((item) => item.id === allocation.installmentId);
          if (!installment) continue;
          installment.payments.push({
            status: "ACTIVE",
            amountPaise: allocation.amountPaise,
            lateFeePortionPaise: allocation.lateFeePortionPaise,
          } as Payment);
        }
        totalPaise += amountPaise;
        if (receiptNo) seenReceiptNos.add(receiptNo.toUpperCase());
      }
    }

    const settles =
      allocations.length === 0
        ? "—"
        : allocations.length === 1
          ? "1 installment"
          : `${allocations.length} installments, oldest first`;

    rowsByIndex.set(position, {
      rowNumber,
      display: [
        receiptNo ?? "auto",
        student?.studentCode ?? studentRef ?? "—",
        student?.fullName ?? nameInFile ?? "—",
        paymentDate instanceof Date ? formatDate(paymentDate) : (get("paymentDate") ?? "—"),
        typeof amount === "number" ? formatPaise(rupeesToPaise(amount)) : (get("amount") ?? "—"),
        settles,
      ],
      errors,
      warnings,
      resolved:
        errors.length === 0 && student && typeof amount === "number" && paymentDate instanceof Date && mode
          ? {
              studentId: student.id,
              studentCode: student.studentCode,
              amountPaise: rupeesToPaise(amount),
              paymentDate,
              mode,
              receiptNo,
              referenceNo: get("referenceNo"),
              remarks: get("remarks"),
              allocations,
            }
          : undefined,
    });
  }

  // Back to file order for display, so the Admin can find each row in the sheet.
  const rows = [...rowsByIndex.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);

  return {
    fileName,
    storagePath,
    totalRows: rows.length,
    validRows: rows.filter((row) => row.errors.length === 0).length,
    rows,
    fatal: [],
    totalPaise,
  };
}

export type ReceiptOutcome = { created: number; skipped: number; totalPaise: number; receiptNos: string[] };

/**
 * Writes the valid rows. Each is re-allocated against the live database in
 * payment-date order, exactly as recording them one at a time would, so the
 * installment statuses and late fees end up identical.
 */
export async function commitReceiptImport(preview: ReceiptPreview, actorId: string): Promise<ReceiptOutcome> {
  const valid = preview.rows
    .map((row) => row.resolved)
    .filter((row): row is ResolvedReceipt => Boolean(row))
    .sort((a, b) => a.paymentDate.getTime() - b.paymentDate.getTime());

  if (valid.length === 0) throw new ValidationError("There are no valid rows to import.");

  const config = await getConfig();
  const receiptNos: string[] = [];
  let totalPaise = 0;

  const studentIds = new Set<string>();

  await prisma.$transaction(
    async (tx) => {
      const slabs = await tx.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } });

      for (const entry of valid) {
        const student = await tx.student.findUniqueOrThrow({
          where: { id: entry.studentId },
          select: { studentCode: true, application: { select: { isProvisional: true } } },
        });

        const installments = await tx.installment.findMany({
          where: { feeAssignment: { studentId: entry.studentId } },
          include: { payments: true },
          orderBy: [{ dueDate: "asc" }, { seqNo: "asc" }],
        });

        const { allocations, unallocatedPaise } = allocateFifo({
          installments,
          amountPaise: entry.amountPaise,
          slabs,
          config,
          asOf: entry.paymentDate,
          lateFeeExempt: student.application.isProvisional,
        });

        if (allocations.length === 0 || unallocatedPaise > 0) {
          // The database moved between preview and commit.
          throw new ValidationError(
            `${student.studentCode} can no longer take ${formatPaise(entry.amountPaise)} — the outstanding balance changed since the preview. Re-check the file.`,
          );
        }

        const number =
          entry.receiptNo ??
          formatSequence(config.receiptPrefix, await nextSequenceValue(SEQ.RECEIPT, tx), config.receiptPadding);

        for (const [i, allocation] of allocations.entries()) {
          await tx.payment.create({
            data: {
              receiptNo: number,
              receiptSeq: i + 1,
              kind: "INSTALLMENT",
              installmentId: allocation.installmentId,
              studentId: entry.studentId,
              amountPaise: allocation.amountPaise,
              lateFeePortionPaise: allocation.lateFeePortionPaise,
              paymentDate: entry.paymentDate,
              mode: entry.mode,
              referenceNo: entry.referenceNo,
              remarks: entry.remarks,
              collectedById: actorId,
            },
          });
          await refreshInstallment(allocation.installmentId, tx, entry.paymentDate);
        }

        receiptNos.push(number);
        totalPaise += entry.amountPaise;
        studentIds.add(entry.studentId);
      }

      await recordAuditTx(tx, {
        userId: actorId,
        action: "fee.receipts_imported",
        summary: `Receipt import from ${preview.fileName} — ${receiptNos.length} receipt(s) totalling ${formatPaise(totalPaise)}`,
        metadata: { receiptNos, fileName: preview.fileName },
      });
    },
    { timeout: 120_000 },
  );

  // Installment 1 carries the registration money, so a settled first installment
  // confirms a provisional admission — same as a single collection does.
  for (const studentId of studentIds) {
    const student = await prisma.student.findUnique({ where: { id: studentId }, select: { applicationId: true } });
    if (student) await settleProvisionalAdmission(student.applicationId, actorId);
  }

  return {
    created: receiptNos.length,
    skipped: preview.rows.length - receiptNos.length,
    totalPaise,
    receiptNos,
  };
}
