import "server-only";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { balanceOf } from "@/lib/late-fees";
import { extraChargeKindLabel } from "@/lib/students";

/**
 * Building what Manthan Campus is told.
 *
 * Manthan Campus — the attendance & academic application — holds a read-only
 * copy of who is enrolled and what they owe. It never computes a balance of its
 * own; it displays ours. So these payloads are built from the same primitives
 * the Student Ledger report is built from, above all `balanceOf`, and the two
 * therefore cannot drift apart and start telling a family different numbers.
 *
 * Every line carries a **stable identifier** — `installment:<id>`,
 * `payment:<id>` and so on. That is what makes the whole integration idempotent
 * from the far end: redelivering a payload updates the rows it wrote last time
 * instead of posting the money twice.
 *
 * Amounts are integer paise, exactly as stored. No rupee figure crosses the
 * wire.
 */

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export type CampusStudentPayload = Record<string, unknown>;

/**
 * The student as Manthan Campus should see them.
 *
 * Returns null when the student has been deleted since being queued, which the
 * publisher treats as nothing to send rather than an error.
 */
export async function buildStudentPayload(studentId: string): Promise<CampusStudentPayload | null> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      department: true,
      course: true,
      batch: true,
      currentSemester: { include: { academicYear: true } },
      application: {
        select: {
          guardians: {
            select: { name: true, email: true, phone: true, isPrimary: true, relation: true },
            orderBy: { isPrimary: "desc" },
          },
        },
      },
    },
  });
  if (!student) return null;

  const guardian = student.application?.guardians[0] ?? null;
  const year = student.currentSemester?.academicYear ?? null;

  return {
    // The ERP's own primary key is the identity the far end keys on. It is
    // opaque and permanent, unlike the student code, which the office can
    // in principle re-issue.
    erpStudentId: student.id,
    studentCode: student.studentCode,

    fullName: student.fullName,
    email: student.email ?? null,
    phone: student.phone ?? null,

    guardianName: guardian?.name ?? null,
    guardianEmail: guardian?.email ?? null,
    guardianPhone: guardian?.phone ?? null,

    department: student.department
      ? { erpId: student.department.id, code: student.department.code, name: student.department.name }
      : null,
    course: student.course
      ? { erpId: student.course.id, code: student.course.code, name: student.course.name }
      : null,
    batch: student.batch
      ? {
          erpId: student.batch.id,
          code: student.batch.code,
          name: student.batch.name,
          startDate: student.batch.startDate?.toISOString() ?? null,
          completionDate: student.batch.completionDate?.toISOString() ?? null,
          status: student.batch.status,
        }
      : null,
    semester: student.currentSemester
      ? {
          erpId: student.currentSemester.id,
          semesterNumber: student.currentSemester.semesterNumber,
          yearNumber: student.currentSemester.yearNumber,
          startDate: student.currentSemester.startDate?.toISOString() ?? null,
          endDate: student.currentSemester.endDate?.toISOString() ?? null,
        }
      : null,
    academicSession: year
      ? {
          erpId: year.id,
          name: year.name,
          startDate: year.startDate.toISOString(),
          endDate: year.endDate.toISOString(),
        }
      : null,

    status: student.status,
    updatedAt: student.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fees and ledger
// ---------------------------------------------------------------------------

export type CampusFinancePayload = Record<string, unknown>;

/**
 * The student's financial position: one fee line per installment, one ledger
 * entry per movement of money, and the totals.
 *
 * Sent as a *complete* picture rather than a change set. The receiving side
 * then removes anything it holds that is no longer here, which is the only way
 * a cancelled receipt or a scrapped fee structure — a course change — ever
 * reaches it: a cancelled row is not sent, it is simply absent.
 */
export async function buildFinancePayload(studentId: string): Promise<CampusFinancePayload | null> {
  const config = await getConfig();
  const slabs = await prisma.lateFeeSlab.findMany({
    where: { isActive: true },
    orderBy: { minDaysOverdue: "asc" },
  });

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      application: { select: { isProvisional: true } },
      feeAssignments: {
        include: {
          semester: { include: { academicYear: true } },
          installments: {
            include: { payments: true, discounts: true },
            orderBy: { seqNo: "asc" },
          },
        },
        orderBy: [{ yearNumber: "asc" }, { createdAt: "asc" }],
      },
      // A cancelled receipt is money that never stayed with the institute, so
      // it is left out entirely — exactly as the Student Ledger leaves it out.
      payments: {
        where: { status: "ACTIVE" },
        include: { installment: { include: { feeAssignment: { include: { semester: true } } } } },
        orderBy: { paymentDate: "asc" },
      },
    },
  });
  if (!student) return null;

  const now = new Date();
  const exempt = student.application.isProvisional;

  const fees: Record<string, unknown>[] = [];
  const ledger: Record<string, unknown>[] = [];

  let totalFees = 0;
  let totalPaid = 0;
  let totalDue = 0;
  let overdue = 0;
  let concession = 0;
  let nextDueDate: Date | null = null;
  let nextDuePaise = 0;

  for (const assignment of student.feeAssignments) {
    const sessionName = assignment.semester.academicYear?.name ?? null;
    const semesterNumber = assignment.semester.semesterNumber;

    // Each fee head is debited on the day it was assigned, matching the ledger.
    const heads: [string, number, string][] = [
      ["tuition", assignment.tuitionComponentPaise, "Tuition fee"],
      ["exam", assignment.examFeePaise, "Exam fee"],
      ["activity", assignment.activityFeePaise, "Activity fee"],
    ];
    for (const [key, amount, label] of heads) {
      if (amount <= 0) continue;
      ledger.push({
        erpTransactionId: `assign:${assignment.id}:${key}`,
        entryDate: assignment.createdAt.toISOString(),
        description: `${label} assigned — semester ${semesterNumber} (Year ${assignment.yearNumber})`,
        feeType: label,
        debitPaise: amount,
        creditPaise: 0,
        academicSession: sessionName,
        semesterNumber,
        createdAt: assignment.createdAt.toISOString(),
      });
    }

    const extras = assignment.installments.filter((i) => i.extraChargeKind !== null);
    for (const extra of extras) {
      ledger.push({
        erpTransactionId: `extra:${extra.id}`,
        entryDate: extra.createdAt.toISOString(),
        description: extra.label ?? extraChargeKindLabel(extra.extraChargeKind),
        feeType: extraChargeKindLabel(extra.extraChargeKind),
        debitPaise: extra.amountPaise,
        creditPaise: 0,
        academicSession: sessionName,
        semesterNumber,
        createdAt: extra.createdAt.toISOString(),
      });
    }

    // Whatever the three heads and the extras do not account for — a migrated
    // opening balance, most often. Kept so the debits equal what was billed.
    const headsTotal = assignment.tuitionComponentPaise + assignment.examFeePaise + assignment.activityFeePaise;
    const extrasTotal = extras.reduce((sum, e) => sum + e.amountPaise, 0);
    const remainder = assignment.totalPayablePaise - headsTotal - extrasTotal;
    if (remainder > 0) {
      ledger.push({
        erpTransactionId: `assign:${assignment.id}:remainder`,
        entryDate: assignment.createdAt.toISOString(),
        description: assignment.note ?? `Adjustment on assigned fee — semester ${semesterNumber}`,
        debitPaise: remainder,
        creditPaise: 0,
        academicSession: sessionName,
        semesterNumber,
        createdAt: assignment.createdAt.toISOString(),
      });
    }

    const planCount = assignment.installments.length - extras.length;

    for (const installment of assignment.installments) {
      const balance = balanceOf(installment, slabs, config, now, exempt);
      const isExtra = installment.extraChargeKind !== null;

      const label = isExtra
        ? (installment.label ?? extraChargeKindLabel(installment.extraChargeKind))
        : `Installment ${installment.seqNo} of ${planCount}`;

      // One fee line per installment. This is what the far end's Due Fees page
      // lists, so it carries the figures a family is quoted at the counter.
      const outstanding = balance.totalOutstandingPaise;
      const status =
        installment.status === "WAIVED"
          ? "CANCELLED"
          : outstanding <= 0
            ? "PAID"
            : balance.principalPaidPaise + balance.lateFeePaidPaise + balance.discountPaise > 0
              ? "PARTIALLY_PAID"
              : balance.daysOverdue > 0
                ? "OVERDUE"
                : "DUE";

      fees.push({
        erpFeeId: `installment:${installment.id}`,
        feeType: isExtra ? extraChargeKindLabel(installment.extraChargeKind) : "Semester Fees",
        description: `${label} — semester ${semesterNumber}`,
        academicSession: sessionName,
        semesterNumber,
        amountPaise: installment.amountPaise,
        paidPaise: balance.principalPaidPaise,
        concessionPaise: balance.discountPaise,
        outstandingPaise: outstanding,
        dueDate: installment.dueDate.toISOString(),
        status,
        updatedAt: installment.updatedAt.toISOString(),
      });

      totalFees += installment.amountPaise;
      totalPaid += balance.principalPaidPaise + balance.lateFeePaidPaise;
      concession += balance.discountPaise;
      if (installment.status !== "WAIVED") {
        totalDue += outstanding;
        if (balance.daysOverdue > 0) overdue += outstanding;
        if (outstanding > 0 && (nextDueDate === null || installment.dueDate < nextDueDate)) {
          nextDueDate = installment.dueDate;
          nextDuePaise = outstanding;
        }
      }

      // A concession is a credit against the charge, never a reduction of it,
      // so the full fee stands and the discount appears on its own line.
      for (const discount of installment.discounts) {
        if (discount.cancelledAt) continue;
        const isLateFeeCredit = discount.reason === "LATE_FEE_ADJUSTMENT";
        ledger.push({
          erpTransactionId: `discount:${discount.id}`,
          entryDate: discount.grantedAt.toISOString(),
          description: isLateFeeCredit
            ? `Late fee waived — credited against semester ${semesterNumber} installment ${installment.seqNo}`
            : `Discount — semester ${semesterNumber} installment ${installment.seqNo}`,
          feeType: isLateFeeCredit ? "Late fee credit" : "Discount",
          debitPaise: 0,
          creditPaise: discount.amountPaise,
          academicSession: sessionName,
          semesterNumber,
          createdAt: discount.grantedAt.toISOString(),
        });
      }

      if (installment.status === "WAIVED") {
        const paid = installment.payments
          .filter((p) => p.status === "ACTIVE")
          .reduce((sum, p) => sum + p.amountPaise, 0);
        const written = Math.max(0, installment.amountPaise - paid);
        if (written > 0) {
          ledger.push({
            erpTransactionId: `waiver:${installment.id}`,
            entryDate: (installment.waivedAt ?? installment.updatedAt).toISOString(),
            description: `Waiver — semester ${semesterNumber} installment ${installment.seqNo}`,
            feeType: "Waiver",
            debitPaise: 0,
            creditPaise: written,
            academicSession: sessionName,
            semesterNumber,
          });
        }
      } else {
        // What was actually charged in late fees: settled plus still owed.
        // Not the live assessment, which collapses to zero once the principal
        // clears and would leave a paid late fee credited but never debited.
        const lateFeeCharged = balance.lateFeePaidPaise + balance.lateFeeOutstandingPaise;
        if (lateFeeCharged > 0) {
          ledger.push({
            erpTransactionId: `latefee:${installment.id}`,
            entryDate: (installment.lateFeeUpdatedAt ?? installment.dueDate).toISOString(),
            description: `Late fee — semester ${semesterNumber} installment ${installment.seqNo}`,
            feeType: "Late fee",
            debitPaise: lateFeeCharged,
            creditPaise: 0,
            academicSession: sessionName,
            semesterNumber,
          });
          totalFees += lateFeeCharged;
        }
      }
    }
  }

  for (const payment of student.payments) {
    const semesterNumber = payment.installment?.feeAssignment.semester.semesterNumber ?? null;
    ledger.push({
      erpTransactionId: `payment:${payment.id}`,
      entryDate: payment.paymentDate.toISOString(),
      description:
        payment.kind === "REGISTRATION" ? "Registration fee received at enrollment" : "Payment received",
      receiptNumber: payment.receiptNo,
      debitPaise: 0,
      creditPaise: payment.amountPaise,
      paymentMode: payment.mode,
      paymentReference: payment.referenceNo ?? null,
      semesterNumber,
      createdAt: payment.createdAt.toISOString(),
    });
    // Registration money not applied to any installment is still money paid.
    if (!payment.installmentId) {
      totalPaid += payment.amountPaise;
      totalFees += payment.amountPaise;
    }
  }

  // The running balance the far end displays, computed once here so both
  // systems show the same closing figure.
  ledger.sort((a, b) => new Date(a.entryDate as string).getTime() - new Date(b.entryDate as string).getTime());
  let running = 0;
  for (const entry of ledger) {
    running += (entry.debitPaise as number) - (entry.creditPaise as number);
    entry.balancePaise = running;
  }

  return {
    erpStudentId: student.id,
    complete: true,
    summary: {
      totalFeesPaise: Math.max(0, totalFees),
      totalPaidPaise: Math.max(0, totalPaid),
      totalDuePaise: totalDue,
      overduePaise: overdue,
      concessionPaise: concession,
      nextDueDate: nextDueDate ? (nextDueDate as Date).toISOString() : null,
      nextDuePaise: nextDueDate ? nextDuePaise : null,
      updatedAt: new Date().toISOString(),
    },
    fees,
    ledger,
  };
}
