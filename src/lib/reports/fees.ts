import "server-only";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { balanceOf, overdueBucket } from "@/lib/late-fees";
import { endOfDay, formatDate, fromDateInput } from "@/lib/dates";
import { formatPaisePlain } from "@/lib/money";
import { discountReasonLabel, extraChargeKindLabel, installmentStatusLabel } from "@/lib/students";
import { buildFilterSummary } from "./academic";
import type { ReportParams, ReportResult, ReportRow, ReportSection } from "./types";
import type { Prisma } from "@/generated/prisma/client";

/** Department / course / batch filter expressed against a related Student. */
function studentScope(params: ReportParams) {
  return {
    ...(params.departmentId ? { departmentId: params.departmentId } : {}),
    ...(params.courseId ? { courseId: params.courseId } : {}),
    ...(params.batchId ? { batchId: params.batchId } : {}),
  };
}

/**
 * Fee Collection (spec 7 / 3.4).
 *
 * Cancelled receipts are excluded entirely — they are not revenue and must not
 * appear in this report or its totals. The Receipts register is where a voided
 * receipt stays on record.
 */
export async function feeCollectionReport(params: ReportParams): Promise<ReportResult> {
  const from = params.from ? fromDateInput(params.from) : null;
  const to = params.to ? endOfDay(fromDateInput(params.to)) : null;

  const where: Prisma.PaymentWhereInput = {
    status: "ACTIVE",
    ...(params.mode ? { mode: params.mode as Prisma.PaymentWhereInput["mode"] } : {}),
    ...(params.collectedById ? { collectedById: params.collectedById } : {}),
    ...(from || to ? { paymentDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(params.departmentId || params.courseId || params.batchId
      ? { student: { is: studentScope(params) } }
      : {}),
  };

  const payments = await prisma.payment.findMany({
    where,
    include: {
      student: { include: { department: true, course: true, batch: true } },
      application: { select: { applicationNo: true, fullName: true } },
      collectedBy: { select: { name: true } },
      installment: { include: { feeAssignment: { include: { semester: true } } } },
    },
    orderBy: { paymentDate: "desc" },
  });

  const rows: ReportRow[] = payments.map((payment) => ({
    receiptNo: payment.receiptNo,
    paymentDate: formatDate(payment.paymentDate),
    studentCode: payment.student?.studentCode ?? payment.application?.applicationNo ?? "—",
    studentName: payment.student?.fullName ?? payment.application?.fullName ?? "—",
    department: payment.student?.department.name ?? "—",
    course: payment.student?.course.name ?? "—",
    batch: payment.student?.batch.name ?? "—",
    installmentRef:
      payment.kind === "REGISTRATION"
        ? "Registration fee"
        : `Sem ${payment.installment?.feeAssignment.semester.semesterNumber ?? "—"} / Installment ${payment.installment?.seqNo ?? "—"}`,
    mode: payment.mode.replaceAll("_", " ").toLowerCase(),
    referenceNo: payment.referenceNo ?? "—",
    collectedBy: payment.collectedBy?.name ?? "—",
    lateFeePortion: formatPaisePlain(payment.lateFeePortionPaise),
    amount: formatPaisePlain(payment.amountPaise),
  }));

  const total = payments.reduce((sum, p) => sum + p.amountPaise, 0);
  const totalLateFee = payments.reduce((sum, p) => sum + p.lateFeePortionPaise, 0);

  return {
    title: "Fee Collection",
    landscape: true,
    columns: [
      { key: "receiptNo", header: "Transaction ID", width: 68 },
      { key: "paymentDate", header: "Date", width: 62 },
      { key: "studentCode", header: "Student ID", width: 66 },
      { key: "studentName", header: "Student", width: 100 },
      { key: "department", header: "Department", width: 82 },
      { key: "course", header: "Course", width: 92 },
      { key: "batch", header: "Batch", width: 76 },
      { key: "installmentRef", header: "Installment ref", width: 108 },
      { key: "mode", header: "Mode", width: 56 },
      { key: "collectedBy", header: "Collected by", width: 82 },
      { key: "lateFeePortion", header: "Late fee", width: 54, align: "right", money: true },
      { key: "amount", header: "Amount", width: 62, align: "right", money: true },
    ],
    rows,
    totals: {
      receiptNo: "TOTAL",
      paymentDate: "",
      studentCode: "",
      studentName: "",
      department: "",
      course: "",
      batch: "",
      installmentRef: `${new Set(payments.map((p) => p.receiptNo)).size} receipt(s), ${payments.length} allocation(s)`,
      mode: "",
      collectedBy: "",
      lateFeePortion: formatPaisePlain(totalLateFee),
      amount: formatPaisePlain(total),
    },
    filterSummary: [
      ...(await buildFilterSummary(params, { hasStatusFilter: false })),
      "Cancelled / voided receipts are excluded",
    ],
    notes: ["Cancelled receipts are excluded entirely from this report and its totals."],
  };
}

/** Guardians read most usefully with the primary contact first. */
function guardianOrder(a: { isPrimary: boolean }, b: { isPrimary: boolean }): number {
  return Number(b.isPrimary) - Number(a.isPrimary);
}

const GUARDIAN_RELATION: Record<string, string> = {
  FATHER: "Father",
  MOTHER: "Mother",
  GUARDIAN: "Guardian",
};

/**
 * Fee Due (spec 7) — one row per student, every outstanding installment of
 * theirs combined.
 *
 * The money block is built so it reconciles on its own:
 *
 *     Total Fees      = Total Paid + Current Dues + Future Dues
 *     Current Payable = Current Dues + Late Fee
 *     Total Payable   = Current Dues + Future Dues + Late Fee
 *
 * For that to hold, Total Fees is the fee *net* of discounts and waivers — a
 * written-off installment is no longer owed by anyone, so counting it would
 * leave the row not adding up. The gross charge, every concession and who
 * authorised it are all in the Student Ledger.
 *
 * "Current" means the due date has arrived (today included); "Future" means it
 * has not. Late fee only ever accrues on the current side, so Current Payable
 * is what the office should actually ask for today.
 */
export async function feeDueReport(params: ReportParams): Promise<ReportResult> {
  const config = await getConfig();
  const slabs = await prisma.lateFeeSlab.findMany({
    where: { isActive: true },
    orderBy: { minDaysOverdue: "asc" },
  });

  const now = new Date();
  const dueBy = endOfDay(now);
  const from = params.from ? fromDateInput(params.from) : null;
  const to = params.to ? endOfDay(fromDateInput(params.to)) : null;

  // Every installment is loaded, not just the unpaid ones: Total Fees and Total
  // Paid describe the student's whole account, which is the point of collapsing
  // them onto one row.
  const students = await prisma.student.findMany({
    where: {
      // Dropped-out and expelled students have no live dues (spec 4.5).
      status: { in: ["ACTIVE", "PASSED"] },
      ...studentScope(params),
    },
    include: {
      department: true,
      course: true,
      batch: true,
      application: {
        select: {
          isProvisional: true,
          guardians: { select: { name: true, relation: true, phone: true, isPrimary: true } },
        },
      },
      feeAssignments: {
        include: { installments: { include: { payments: true }, orderBy: { dueDate: "asc" } } },
      },
    },
    orderBy: { studentCode: "asc" },
  });

  /**
   * The formatted row plus the raw paise it was built from. Sorting and the
   * totals row work off the integers — re-parsing the formatted money back into
   * a number would introduce rounding error a fee report cannot afford.
   */
  type DueEntry = {
    row: ReportRow;
    totalFees: number;
    totalPaid: number;
    currentDues: number;
    futureDues: number;
    lateFee: number;
    currentPayable: number;
    totalPayable: number;
    studentCode: string;
  };
  const entries: DueEntry[] = [];

  for (const student of students) {
    let totalFees = 0;
    let totalPaid = 0;
    let currentDues = 0;
    let futureDues = 0;
    let lateFee = 0;
    let maxDaysOverdue = 0;
    let nextDue: Date | null = null;
    let dueInRange = false;

    for (const assignment of student.feeAssignments) {
      for (const installment of assignment.installments) {
        const balance = balanceOf(installment, slabs, config, now, student.application.isProvisional);

        totalPaid += balance.principalPaidPaise;
        // Paid + still owed, so a waiver or discount leaves the row balanced
        // rather than showing a fee nobody will ever collect.
        totalFees += balance.principalPaidPaise + balance.principalOutstandingPaise;
        lateFee += balance.lateFeeOutstandingPaise;

        if (balance.principalOutstandingPaise > 0) {
          if (installment.dueDate <= dueBy) currentDues += balance.principalOutstandingPaise;
          else futureDues += balance.principalOutstandingPaise;
        }

        if (balance.totalOutstandingPaise > 0) {
          maxDaysOverdue = Math.max(maxDaysOverdue, balance.daysOverdue);
          if (!nextDue || installment.dueDate < nextDue) nextDue = installment.dueDate;
          // The date range picks which students are listed, never which of
          // their installments are counted — the totals stay whole.
          if ((!from || installment.dueDate >= from) && (!to || installment.dueDate <= to)) dueInRange = true;
        }
      }
    }

    const currentPayable = currentDues + lateFee;
    const totalPayable = currentDues + futureDues + lateFee;

    // Nothing owed at all is not a due.
    if (totalPayable <= 0) continue;
    if ((from || to) && !dueInRange) continue;
    if (params.dueStatus === "current" && currentPayable <= 0) continue;
    if (params.dueStatus === "future" && currentPayable > 0) continue;
    if (params.lateFeeOnly === "with" && lateFee <= 0) continue;
    if (params.lateFeeOnly === "without" && lateFee > 0) continue;

    const bucket = overdueBucket(maxDaysOverdue);
    if (params.overdueBucket && params.overdueBucket !== bucket) continue;

    const guardians = [...student.application.guardians].sort(guardianOrder);
    const parentPhones = [...new Set(guardians.map((g) => g.phone).filter(Boolean))];

    entries.push({
      row: {
        studentCode: student.studentCode,
        studentName: student.fullName,
        contact: student.phone ?? student.email ?? "—",
        parentName:
          guardians.map((g) => `${g.name} (${GUARDIAN_RELATION[g.relation] ?? g.relation})`).join(" · ") || "—",
        parentPhone: parentPhones.join(" · ") || "—",
        department: student.department.name,
        course: student.course.name,
        batch: student.batch.name,
        nextDueDate: formatDate(nextDue),
        daysOverdue: maxDaysOverdue,
        bucket: bucket === "not-due" ? "Not yet due" : `${bucket} days`,
        totalFees: formatPaisePlain(totalFees),
        totalPaid: formatPaisePlain(totalPaid),
        currentDues: formatPaisePlain(currentDues),
        futureDues: formatPaisePlain(futureDues),
        lateFee: formatPaisePlain(lateFee),
        currentPayable: formatPaisePlain(currentPayable),
        totalPayable: formatPaisePlain(totalPayable),
      },
      totalFees,
      totalPaid,
      currentDues,
      futureDues,
      lateFee,
      currentPayable,
      totalPayable,
      studentCode: student.studentCode,
    });
  }

  // Whoever works this list starts at the top, so the biggest amount collectable
  // today comes first.
  entries.sort(
    (a, b) =>
      b.currentPayable - a.currentPayable ||
      b.totalPayable - a.totalPayable ||
      a.studentCode.localeCompare(b.studentCode),
  );

  const sum = (key: Exclude<keyof DueEntry, "row" | "studentCode">) =>
    entries.reduce((total, entry) => total + entry[key], 0);

  const dueStatusLabel =
    params.dueStatus === "current"
      ? "Due now only — students with nothing payable today are excluded"
      : params.dueStatus === "future"
        ? "Not yet due only — students with anything payable today are excluded"
        : null;

  return {
    title: "Fee Due",
    landscape: true,
    columns: [
      { key: "studentCode", header: "Student ID", width: 52 },
      { key: "studentName", header: "Student", width: 80 },
      { key: "contact", header: "Contact", width: 64 },
      { key: "parentName", header: "Parent / guardian", width: 78 },
      { key: "parentPhone", header: "Parent phone", width: 64 },
      { key: "department", header: "Department", width: 62 },
      { key: "course", header: "Course", width: 70 },
      { key: "batch", header: "Batch", width: 54 },
      { key: "nextDueDate", header: "Next due", width: 52 },
      { key: "daysOverdue", header: "Days", width: 28, align: "right" },
      { key: "bucket", header: "Bucket", width: 46 },
      { key: "totalFees", header: "Total Fees", width: 58, align: "right", money: true },
      { key: "totalPaid", header: "Total Paid", width: 58, align: "right", money: true },
      { key: "currentDues", header: "Current Dues", width: 58, align: "right", money: true },
      { key: "futureDues", header: "Future Dues", width: 58, align: "right", money: true },
      { key: "lateFee", header: "Late Fee", width: 50, align: "right", money: true },
      { key: "currentPayable", header: "Current Payable", width: 62, align: "right", money: true },
      { key: "totalPayable", header: "Total Payable", width: 62, align: "right", money: true },
    ],
    rows: entries.map((entry) => entry.row),
    totals: {
      studentCode: "TOTAL",
      studentName: `${entries.length} student(s)`,
      contact: "",
      parentName: "",
      parentPhone: "",
      department: "",
      course: "",
      batch: "",
      nextDueDate: "",
      daysOverdue: "",
      bucket: "",
      totalFees: formatPaisePlain(sum("totalFees")),
      totalPaid: formatPaisePlain(sum("totalPaid")),
      currentDues: formatPaisePlain(sum("currentDues")),
      futureDues: formatPaisePlain(sum("futureDues")),
      lateFee: formatPaisePlain(sum("lateFee")),
      currentPayable: formatPaisePlain(sum("currentPayable")),
      totalPayable: formatPaisePlain(sum("totalPayable")),
    },
    filterSummary: [
      ...(await buildFilterSummary(params, { hasStatusFilter: false })),
      ...(dueStatusLabel ? [dueStatusLabel] : []),
      "Dropped-out and expelled students are excluded — their dues are waived",
    ],
    notes: [
      "One row per student — every outstanding installment is combined. Current Dues are those whose due date has " +
        "arrived; Future Dues are not yet due. Current Payable = Current Dues + Late Fee, and is what to collect today.",
      "Total Fees is net of discounts and waivers, so each row reconciles: Total Fees = Total Paid + Current Dues + " +
        "Future Dues. The gross charge and every concession are on the Student Ledger.",
    ],
  };
}

/**
 * Student Ledger (spec 7 / 3.4) — a full transaction history, not a revenue
 * view. Fee assignments and late fees are debits, payments are credits, and
 * waivers reduce the balance.
 *
 * Cancelled receipts are left out: a void means the money never stayed with the
 * institute, and showing it — even at zero — invites the family to argue they
 * paid twice. The void itself is not lost, it lives in the Receipts register
 * (with who cancelled it, when and why) and in the audit trail.
 */
export async function ledgerReport(params: ReportParams): Promise<ReportResult> {
  const config = await getConfig();
  const slabs = await prisma.lateFeeSlab.findMany({
    where: { isActive: true },
    orderBy: { minDaysOverdue: "asc" },
  });

  if (!params.studentId) {
    return {
      title: "Student Ledger",
      columns: [{ key: "message", header: "Student Ledger" }],
      rows: [{ message: "Select a student to view their ledger." }],
      filterSummary: [],
    };
  }

  const student = await prisma.student.findUnique({
    where: { id: params.studentId },
    include: {
      department: true,
      course: true,
      batch: true,
      application: { select: { isProvisional: true } },
      feeAssignments: {
        include: {
          semester: true,
          installments: {
            include: { payments: true, discounts: { include: { grantedBy: { select: { name: true } } } } },
            orderBy: { seqNo: "asc" },
          },
        },
        orderBy: [{ yearNumber: "asc" }, { createdAt: "asc" }],
      },
      // A cancelled receipt is money that never stayed with the institute, so it
      // is kept off the ledger entirely rather than shown as a zero-effect line.
      // The void is still on record: the Receipts register keeps the cancelled
      // row with its reason, and the audit trail keeps `fee.receipt_cancelled`.
      payments: {
        where: { status: "ACTIVE" },
        include: { installment: { include: { feeAssignment: { include: { semester: true } } } }, collectedBy: { select: { name: true } } },
        orderBy: { paymentDate: "asc" },
      },
    },
  });

  if (!student) {
    return {
      title: "Student Ledger",
      columns: [{ key: "message", header: "Student Ledger" }],
      rows: [{ message: "Student not found." }],
      filterSummary: [],
    };
  }

  const from = params.from ? fromDateInput(params.from) : null;
  const to = params.to ? endOfDay(fromDateInput(params.to)) : null;
  const now = new Date();
  const dueBy = endOfDay(now);

  type Entry = {
    date: Date;
    receipt: string;
    particulars: string;
    debit: number;
    credit: number;
    status: string;
    /**
     * Not printed — the Remarks column was removed from the ledger. Kept because
     * it is where the working behind a line is spelled out (how a scholarship
     * was applied, a discount's reason and who granted it, a payment's mode and
     * reference), and restoring the column is then a one-line change.
     */
    note: string;
  };
  const entries: Entry[] = [];

  /** Every installment still carrying a balance — the schedule still to pay. */
  type OutstandingInstallment = {
    /** Carried so the section can offer the late fee write-off on the row. */
    id: string;
    dueDate: Date;
    semesterNumber: number;
    seqNo: number;
    of: number;
    /** Set on an extra charge — what it is for, instead of "2 of 4". */
    label: string | null;
    amountPaise: number;
    paidPaise: number;
    principalOutstandingPaise: number;
    lateFeePaise: number;
    totalPaise: number;
    daysOverdue: number;
  };
  const outstanding: OutstandingInstallment[] = [];

  /**
   * Registration money received but not applied to any installment.
   *
   * Records created through the app apply it to the first installment, so the
   * assigned total covers the full fee. Imported records instead had the
   * registration fee *deducted* from the assigned total, which leaves the
   * assignment short of its own fee heads by exactly this much. Crediting the
   * payment as well as that shortfall would count the same money twice and
   * understate what the student owes — see the remainder handling below.
   */
  let unappliedRegistrationPaise = student.payments
    .filter((payment) => payment.kind === "REGISTRATION" && !payment.installmentId)
    .reduce((sum, payment) => sum + payment.amountPaise, 0);

  for (const assignment of student.feeAssignments) {
    if (params.semesterId && assignment.semesterId !== params.semesterId) continue;

    // Each fee head is charged on its own line — tuition net of scholarship, and
    // exam and activity fees separately, raised at enrollment and again at every
    // promotion. The registration fee is never deducted from any of them.
    const semesterLabel = `semester ${assignment.semester.semesterNumber}`;

    if (assignment.tuitionComponentPaise > 0) {
      entries.push({
        date: assignment.createdAt,
        receipt: "",
        particulars: `Tuition fee assigned — ${semesterLabel} (Year ${assignment.yearNumber})`,
        debit: assignment.tuitionComponentPaise,
        credit: 0,
        status: "Assigned",
        note:
          assignment.scholarshipAmountPaise > 0
            ? `Batch tuition ${formatPaisePlain(assignment.lockedTuitionRatePaise)} less ${
                assignment.scholarshipPercent > 0 ? `${assignment.scholarshipPercent}% ` : ""
              }scholarship ${formatPaisePlain(assignment.scholarshipAmountPaise)}`
            : `Rate locked at enrollment: ${formatPaisePlain(assignment.lockedTuitionRatePaise)}`,
      });
    }

    if (assignment.examFeePaise > 0) {
      entries.push({
        date: assignment.createdAt,
        receipt: "",
        particulars: `Exam fee assigned — ${semesterLabel}`,
        debit: assignment.examFeePaise,
        credit: 0,
        status: "Assigned",
        note: "Charged at the semester's current value — never rate-locked.",
      });
    }

    if (assignment.activityFeePaise > 0) {
      entries.push({
        date: assignment.createdAt,
        receipt: "",
        particulars: `Activity fee assigned — ${semesterLabel}`,
        debit: assignment.activityFeePaise,
        credit: 0,
        status: "Assigned",
        note: "Charged at the semester's current value — never rate-locked.",
      });
    }

    // Charges raised after enrollment — an activity, an event, a fine. Each is
    // debited on its own line, on the day it fell due, under the description the
    // family was given. They are part of the assignment's total, so they come
    // out of the remainder below rather than being counted twice.
    const extras = assignment.installments.filter((installment) => installment.extraChargeKind !== null);
    for (const extra of extras) {
      entries.push({
        date: extra.createdAt,
        receipt: "",
        particulars: extra.label ?? "Extra charge",
        debit: extra.amountPaise,
        credit: 0,
        status: extraChargeKindLabel(extra.extraChargeKind),
        note: `Raised on ${formatDate(extra.createdAt)} · due ${formatDate(extra.dueDate)}`,
      });
    }
    const extrasPaise = extras.reduce((sum, extra) => sum + extra.amountPaise, 0);

    // Anything the three heads do not account for: a migrated opening balance,
    // or an imported assignment recorded before the registration fee stopped
    // being deducted. Keeps the ledger's debits equal to what was actually billed.
    const heads = assignment.tuitionComponentPaise + assignment.examFeePaise + assignment.activityFeePaise;
    let remainder = assignment.totalPayablePaise - heads - extrasPaise;

    // Where the shortfall is the deducted registration fee, it and the payment
    // credited further down are the same money. The payment is the truthful
    // line — it says who paid what, when — so the shortfall is absorbed here
    // rather than posted as a second credit. Without this the closing balance
    // comes out one registration fee short of what the installments add up to.
    if (remainder < 0 && unappliedRegistrationPaise > 0) {
      const absorbed = Math.min(-remainder, unappliedRegistrationPaise);
      remainder += absorbed;
      unappliedRegistrationPaise -= absorbed;
    }

    if (remainder !== 0) {
      entries.push({
        date: assignment.createdAt,
        receipt: "",
        particulars: assignment.note
          ? `${assignment.note} — ${semesterLabel}`
          : `Adjustment on assigned fee — ${semesterLabel}`,
        debit: remainder > 0 ? remainder : 0,
        credit: remainder < 0 ? -remainder : 0,
        status: "Assigned",
        note: assignment.note
          ? ""
          : "The assignment total differs from the sum of its fee heads — recorded before the registration fee stopped being deducted.",
      });
    }

    // Extra charges are their own charges, so the agreed plan is still "1 of 4"
    // however many of them have been raised since.
    const planCount = assignment.installments.length - extras.length;

    for (const installment of assignment.installments) {
      const balance = balanceOf(installment, slabs, config, now, student.application.isProvisional);
      const isExtra = installment.extraChargeKind !== null;

      // Anything still carrying a balance goes to its own table below the
      // ledger — overdue and not-yet-due alike, so the table adds up to the
      // closing balance. These are not transactions, so they have no place
      // among the debits and credits.
      if (balance.totalOutstandingPaise > 0) {
        outstanding.push({
          id: installment.id,
          dueDate: installment.dueDate,
          semesterNumber: assignment.semester.semesterNumber,
          seqNo: installment.seqNo,
          of: planCount,
          label: isExtra ? (installment.label ?? extraChargeKindLabel(installment.extraChargeKind)) : null,
          amountPaise: balance.netPayablePaise,
          paidPaise: balance.principalPaidPaise,
          principalOutstandingPaise: balance.principalOutstandingPaise,
          lateFeePaise: balance.lateFeeOutstandingPaise,
          totalPaise: balance.totalOutstandingPaise,
          daysOverdue: balance.daysOverdue,
        });
      }

      // Every installment appears on its due date, paid or not, so the ledger
      // doubles as the schedule the family was given at enrollment. An extra
      // charge has already been debited on its own line above.
      if (!isExtra) {
        entries.push({
          date: installment.dueDate,
          receipt: "",
          particulars: `Installment ${installment.seqNo} of ${planCount} due — semester ${assignment.semester.semesterNumber}`,
          debit: 0,
          credit: 0,
          status: installmentStatusLabel(installment.status),
          note: `Amount ${formatPaisePlain(installment.amountPaise)} · paid ${formatPaisePlain(
            balance.principalPaidPaise,
          )} · outstanding ${formatPaisePlain(balance.totalOutstandingPaise)}`,
        });
      }

      // A concession is a credit against the charge, never a reduction of it,
      // so the ledger keeps the full fee and shows the discount on its own line.
      for (const discount of installment.discounts) {
        if (discount.cancelledAt) continue;
        // A late fee credit is not a concession — it is a fine the family paid
        // and has since been let off, handed back against what they owe next.
        // Calling it a discount on their own statement would misdescribe it.
        const isLateFeeCredit = discount.reason === "LATE_FEE_ADJUSTMENT";
        entries.push({
          date: discount.grantedAt,
          receipt: "",
          particulars: isLateFeeCredit
            ? `Late fee waived — credited against semester ${assignment.semester.semesterNumber} installment ${installment.seqNo}`
            : `Discount — semester ${assignment.semester.semesterNumber} installment ${installment.seqNo}`,
          debit: 0,
          credit: discount.amountPaise,
          status: isLateFeeCredit ? "Late fee credit" : "Discount",
          note:
            `${discountReasonLabel(discount.reason)}${discount.percent ? ` · ${discount.percent}% of ${formatPaisePlain(installment.amountPaise)}` : ""}` +
            ` · granted by ${discount.grantedBy?.name ?? "—"} · ${discount.note}`,
        });
      }

      if (installment.status === "WAIVED") {
        const paid = installment.payments
          .filter((p) => p.status === "ACTIVE")
          .reduce((sum, p) => sum + p.amountPaise, 0);
        entries.push({
          date: installment.waivedAt ?? installment.updatedAt,
          receipt: "",
          particulars: `Waiver — semester ${assignment.semester.semesterNumber} installment ${installment.seqNo}`,
          debit: 0,
          credit: Math.max(0, installment.amountPaise - paid),
          status: "Waived",
          note: installment.waivedReason ?? "",
        });
      } else {
        // What the student was actually charged in late fees: whatever they
        // have already settled, plus whatever is still owed.
        //
        // Not `lateFeeAssessedPaise`, which is recomputed live and collapses to
        // zero the moment the principal is cleared — that left a late fee the
        // family had paid credited on the ledger but never debited, quietly
        // understating the balance. Written-off amounts are excluded, because a
        // write-off removes the charge rather than paying it.
        const lateFeeCharged = balance.lateFeePaidPaise + balance.lateFeeOutstandingPaise;
        if (lateFeeCharged > 0) {
          entries.push({
            date: installment.lateFeeUpdatedAt ?? installment.dueDate,
            receipt: "",
            particulars: `Late fee — semester ${assignment.semester.semesterNumber} installment ${installment.seqNo}`,
            debit: lateFeeCharged,
            credit: 0,
            status: "Late fee",
            note:
              balance.lateFeePaidPaise > 0 && balance.lateFeeOutstandingPaise === 0
                ? "Charged and settled"
                : `${balance.daysOverdue} day(s) overdue`,
          });
        }
      }
    }
  }

  for (const payment of student.payments) {
    const against = payment.installment
      ? ` — applied to semester ${payment.installment.feeAssignment.semester.semesterNumber} installment ${payment.installment.seqNo}`
      : "";
    entries.push({
      date: payment.paymentDate,
      receipt: payment.receiptNo,
      particulars:
        payment.kind === "REGISTRATION"
          ? `Registration fee received at enrollment${against}`
          : `Payment received${against}`,
      debit: 0,
      credit: payment.amountPaise,
      status: "Paid",
      note: `${payment.mode.replaceAll("_", " ").toLowerCase()}${payment.referenceNo ? ` · ref ${payment.referenceNo}` : ""}${
        payment.lateFeePortionPaise > 0 ? ` · late fee ${formatPaisePlain(payment.lateFeePortionPaise)}` : ""
      } · collected by ${payment.collectedBy?.name ?? "—"}${payment.remarks ? ` · ${payment.remarks}` : ""}`,
    });
  }

  entries.sort((a, b) => a.date.getTime() - b.date.getTime());

  let balance = 0;
  const rows: ReportRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const entry of entries) {
    // The balance still walks every entry. A zero-value line moves nothing, so
    // dropping it below cannot shift the running balance or the closing figure.
    balance += entry.debit - entry.credit;

    // Entries that move no money are scaffolding, not transactions: the
    // installment schedule line, and the note that a late fee was written off
    // before it was ever charged. They are assembled above because the running
    // balance and the date ordering are built from one list, and are hidden
    // here so the ledger reads as a statement of account rather than a mix of
    // transactions and status markers.
    if (entry.debit === 0 && entry.credit === 0) continue;

    if (from && entry.date < from) continue;
    if (to && entry.date > to) continue;

    totalDebit += entry.debit;
    totalCredit += entry.credit;
    rows.push({
      date: formatDate(entry.date),
      receipt: entry.receipt,
      particulars: entry.particulars,
      status: entry.status,
      debit: entry.debit ? formatPaisePlain(entry.debit) : "",
      credit: entry.credit ? formatPaisePlain(entry.credit) : "",
      balance: formatPaisePlain(balance),
      note: entry.note,
    });
  }

  outstanding.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const outstandingTotal = outstanding.reduce((sum, item) => sum + item.totalPaise, 0);
  const outstandingLateFee = outstanding.reduce((sum, item) => sum + item.lateFeePaise, 0);

  const outstandingInstallmentsSection: ReportSection = {
    title: "Outstanding installments",
    // No description: the table is handed to families, and the Status column
    // says what each row is without a paragraph explaining the accounting.
    emptyMessage: "Nothing outstanding — every installment is settled.",
    columns: [
      { key: "dueDate", header: "Due date", width: 74 },
      { key: "status", header: "Status", width: 74 },
      { key: "semester", header: "Sem", width: 40, align: "right" },
      { key: "installment", header: "Installment", width: 70 },
      { key: "amount", header: "Amount", width: 78, align: "right", money: true },
      { key: "paid", header: "Paid so far", width: 78, align: "right", money: true },
      { key: "lateFee", header: "Late fee", width: 70, align: "right", money: true },
      { key: "outstanding", header: "Outstanding", width: 82, align: "right", money: true },
    ],
    // The write-off is offered on screen, on the rows that still carry a late
    // fee — see `rowAction`. The two keys it needs have no column, so they stay
    // off every export.
    rowAction: "waive-late-fee",
    rows: outstanding.map((item) => ({
      dueDate: formatDate(item.dueDate),
      status:
        item.daysOverdue > 0
          ? `Overdue ${item.daysOverdue} day(s)`
          : item.dueDate <= dueBy
            ? "Due today"
            : "Not yet due",
      semester: item.semesterNumber,
      installment: item.label ?? `${item.seqNo} of ${item.of}`,
      amount: formatPaisePlain(item.amountPaise),
      paid: formatPaisePlain(item.paidPaise),
      lateFee: formatPaisePlain(item.lateFeePaise),
      outstanding: formatPaisePlain(item.totalPaise),
      installmentId: item.id,
      lateFeeOutstandingPaise: item.lateFeePaise,
    })),
    totals: {
      dueDate: "TOTAL",
      status: "",
      semester: "",
      installment: `${outstanding.length} installment(s)`,
      amount: "",
      paid: "",
      lateFee: formatPaisePlain(outstandingLateFee),
      outstanding: formatPaisePlain(outstandingTotal),
    },
  };

  return {
    title: `Student Ledger — ${student.studentCode} ${student.fullName}`,
    landscape: true,
    columns: [
      { key: "date", header: "Date", width: 62 },
      // Clicking the number reprints that receipt — the ledger is where staff
      // land when a family asks for a duplicate.
      { key: "receipt", header: "Receipt", width: 72, linkTemplate: "/api/receipts/{value}" },
      { key: "particulars", header: "Particulars", width: 186 },
      { key: "status", header: "Status", width: 58 },
      { key: "debit", header: "Debit", width: 64, align: "right", money: true },
      { key: "credit", header: "Credit", width: 64, align: "right", money: true },
      { key: "balance", header: "Balance", width: 66, align: "right", money: true },
    ],
    rows,
    sections: [outstandingInstallmentsSection],
    totals: {
      date: "TOTAL",
      receipt: "",
      particulars: `${student.department.name} · ${student.course.name} · ${student.batch.name}`,
      status: "",
      debit: formatPaisePlain(totalDebit),
      credit: formatPaisePlain(totalCredit),
      balance: formatPaisePlain(balance),
    },
    // Deliberately empty. A ledger is a statement of one student's account, and
    // it is handed to that student — the filter block belonged on the analytical
    // reports, not here. The student is already named in the title, and the
    // generation timestamp still prints beneath it.
    filterSummary: [],
    notes: [
      "Tuition is charged net of scholarship. Exam and activity fees are charged on their own lines, raised at enrollment and again at each promotion. The registration fee is a payment against these charges, never a deduction from them.",
      "Only entries that move money are listed. Installment schedule lines and other zero-value markers are left out — the charge is raised once, when the fee is assigned. What is still owed is in the Outstanding installments table below, which adds up to the closing balance.",
      "A late fee written off before it was ever charged moves no money either, so it does not appear here. Those write-offs are on record in the audit trail, with who authorised them and why.",
      "The registration fee collected at enrollment is part of the total fee and is shown applied to the first installment.",
      "Cancelled receipts do not appear here at all. A void is on record in the Receipts register, which keeps the cancelled row with its reason, and in the audit trail.",
      "Every receipt number in the table is a link — open it to reprint that receipt.",
    ],
  };
}
