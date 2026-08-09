import "server-only";
import { prisma, type Db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Changing an enrolled student's course.
 *
 * A course change is not a correction — it is the student moving to a different
 * course, and with it a different batch, a different semester structure and a
 * different fee. The rule the institute works to is:
 *
 *   - the fee structure that came with the old course is **scrapped**: every fee
 *     assignment the student held is deleted along with its installments, so
 *     nothing of the old charge survives to be collected or reported;
 *   - the new course brings a **new fee**, assigned for the semester the student
 *     joins, exactly as approval assigns the first semester's fee;
 *   - **money already received is untouched.** Every receipt keeps its number,
 *     its date, its mode and whoever collected it. What changes is only which
 *     installment each payment settles: the whole amount is re-applied to the
 *     new schedule, oldest payment against earliest installment.
 *
 * This file holds the two pieces both the screen and the action need — what the
 * student currently has, and where their money would land — so the figures the
 * Admin confirms are the ones the action then writes.
 */

/* -------------------------------------------------------------------------- */
/* Carrying the money across                                                   */
/* -------------------------------------------------------------------------- */

export type CarriedPayment = {
  id: string;
  receiptNo: string;
  amountPaise: number;
  lateFeePortionPaise: number;
};

export type PlannedInstallment = { id: string; amountPaise: number };

/** One landing place for one payment. A null installment is unapplied credit. */
export type CreditLine = {
  paymentId: string;
  installmentId: string | null;
  amountPaise: number;
};

export type CarriedCreditPlan = {
  /** Where each payment row itself moves — one line per existing row. */
  moves: CreditLine[];
  /**
   * Further landing places for a payment big enough to span more than one
   * installment. Each becomes an extra line on the same receipt, which is how a
   * single collection already records itself when FIFO spreads it (`receiptSeq`).
   */
  splits: CreditLine[];
  carriedPaise: number;
  allocatedPaise: number;
  /** What the new fee could not absorb — a move to a cheaper course. */
  unallocatedPaise: number;
};

/**
 * Spread money already collected over the new installment plan, oldest payment
 * against earliest installment, filling each one before moving on.
 *
 * This is the FIFO rule collection already works to (`allocateFifo`), turned
 * around: there the unknown is how far one amount reaches, here it is where a
 * known set of payments lands. It is deliberately kept as a pure function so the
 * screen can show the Admin the same allocation the action will write.
 *
 * `payments` must be ordered oldest first and `installments` by sequence.
 */
export function planCarriedCredit({
  payments,
  installments,
}: {
  payments: CarriedPayment[];
  installments: PlannedInstallment[];
}): CarriedCreditPlan {
  const capacity = installments.map((installment) => ({ id: installment.id, left: installment.amountPaise }));
  const moves: CreditLine[] = [];
  const splits: CreditLine[] = [];

  let cursor = 0;
  let allocatedPaise = 0;

  for (const payment of payments) {
    let remaining = payment.amountPaise;
    let isFirstLine = true;

    while (remaining > 0 && cursor < capacity.length) {
      if (capacity[cursor].left <= 0) {
        cursor += 1;
        continue;
      }
      const chunk = Math.min(remaining, capacity[cursor].left);
      (isFirstLine ? moves : splits).push({
        paymentId: payment.id,
        installmentId: capacity[cursor].id,
        amountPaise: chunk,
      });
      capacity[cursor].left -= chunk;
      remaining -= chunk;
      allocatedPaise += chunk;
      isFirstLine = false;
    }

    // Nothing left to charge it against. The money stays on the student as an
    // unapplied credit rather than being forced onto a settled installment,
    // where it would simply disappear from the balance.
    if (remaining > 0 || isFirstLine) {
      (isFirstLine ? moves : splits).push({
        paymentId: payment.id,
        installmentId: null,
        amountPaise: isFirstLine ? payment.amountPaise : remaining,
      });
    }
  }

  const carriedPaise = payments.reduce((sum, payment) => sum + payment.amountPaise, 0);
  return {
    moves,
    splits,
    carriedPaise,
    allocatedPaise,
    unallocatedPaise: carriedPaise - allocatedPaise,
  };
}

/* -------------------------------------------------------------------------- */
/* What the student currently has                                              */
/* -------------------------------------------------------------------------- */

const CONTEXT_INCLUDE = {
  department: true,
  course: true,
  batch: { include: { course: true } },
  currentSemester: true,
  application: { select: { id: true, isProvisional: true } },
  feeAssignments: {
    orderBy: [{ yearNumber: "asc" }, { createdAt: "asc" }],
    include: {
      semester: true,
      academicYear: { select: { name: true } },
      installments: {
        orderBy: { seqNo: "asc" },
        include: {
          payments: { where: { status: "ACTIVE" } },
          discounts: { where: { cancelledAt: null } },
        },
      },
    },
  },
} satisfies Prisma.StudentInclude;

export type CourseChangeContext = NonNullable<Awaited<ReturnType<typeof loadCourseChangeContext>>>;

/**
 * The student, the fee structure a course change would scrap, and the money
 * that would carry across.
 *
 * The carried money is read from the student's payments rather than from the
 * installments underneath them, so a credit left unapplied by an earlier course
 * change is picked up too — it is still the family's money, and it still has to
 * find a home on the new plan.
 */
export async function loadCourseChangeContext(studentId: string, db: Db = prisma) {
  const student = await db.student.findUnique({ where: { id: studentId }, include: CONTEXT_INCLUDE });
  if (!student) return null;

  const carriedPayments = await db.payment.findMany({
    where: { studentId, status: "ACTIVE" },
    orderBy: [{ paymentDate: "asc" }, { receiptNo: "asc" }, { receiptSeq: "asc" }],
  });

  const installments = student.feeAssignments.flatMap((assignment) => assignment.installments);
  const assignedPaise = student.feeAssignments.reduce((sum, a) => sum + a.totalPayablePaise, 0);
  const carriedPaise = carriedPayments.reduce((sum, payment) => sum + payment.amountPaise, 0);
  /**
   * Late fee inside that money. It was charged against due dates that are about
   * to stop existing, so it is credited as principal against the new fee rather
   * than kept as a penalty on a schedule nobody can point to — the family's
   * money reaches the new plan in full.
   */
  const carriedLateFeePaise = carriedPayments.reduce((sum, payment) => sum + payment.lateFeePortionPaise, 0);
  const activeDiscountPaise = installments.reduce(
    (sum, installment) => sum + installment.discounts.reduce((total, discount) => total + discount.amountPaise, 0),
    0,
  );

  return {
    student,
    carriedPayments,
    scrapped: {
      assignmentCount: student.feeAssignments.length,
      installmentCount: installments.length,
      assignedPaise,
      activeDiscountPaise,
      activeDiscountCount: installments.reduce((sum, installment) => sum + installment.discounts.length, 0),
      waivedCount: installments.filter((installment) => installment.status === "WAIVED").length,
      extraChargeCount: installments.filter((installment) => installment.extraChargeKind !== null).length,
      lateFeePaise: installments
        .filter((installment) => installment.status !== "WAIVED")
        .reduce((sum, installment) => sum + installment.lateFeePaise, 0),
    },
    carriedPaise,
    carriedLateFeePaise,
  };
}

/**
 * The scrapped structure, written down before it is deleted.
 *
 * Nothing else survives the change: the assignments, their installments and any
 * discount on them are gone from the database, so this snapshot on the
 * `CourseChange` row is the only remaining answer to "what was this student
 * being charged before?".
 */
export function snapshotOfStructure(context: CourseChangeContext) {
  return {
    assignments: context.student.feeAssignments.map((assignment) => ({
      id: assignment.id,
      semesterNumber: assignment.semester.semesterNumber,
      yearNumber: assignment.yearNumber,
      academicYear: assignment.academicYear?.name ?? null,
      lockedTuitionRatePaise: assignment.lockedTuitionRatePaise,
      tuitionComponentPaise: assignment.tuitionComponentPaise,
      scholarshipPercent: assignment.scholarshipPercent,
      scholarshipAmountPaise: assignment.scholarshipAmountPaise,
      examFeePaise: assignment.examFeePaise,
      activityFeePaise: assignment.activityFeePaise,
      totalPayablePaise: assignment.totalPayablePaise,
      note: assignment.note,
      installments: assignment.installments.map((installment) => ({
        id: installment.id,
        seqNo: installment.seqNo,
        dueDate: installment.dueDate.toISOString(),
        amountPaise: installment.amountPaise,
        status: installment.status,
        lateFeePaise: installment.lateFeePaise,
        discountPaise: installment.discountPaise,
        extraChargeKind: installment.extraChargeKind,
        label: installment.label,
        waivedReason: installment.waivedReason,
        paidPaise: installment.payments.reduce((sum, payment) => sum + payment.amountPaise, 0),
        discounts: installment.discounts.map((discount) => ({
          id: discount.id,
          reason: discount.reason,
          percent: discount.percent,
          amountPaise: discount.amountPaise,
          note: discount.note,
        })),
      })),
    })),
    // Where every receipt stood before it was re-applied, so the move is
    // reversible by hand if it is ever disputed.
    payments: context.carriedPayments.map((payment) => ({
      id: payment.id,
      receiptNo: payment.receiptNo,
      receiptSeq: payment.receiptSeq,
      kind: payment.kind,
      paymentDate: payment.paymentDate.toISOString(),
      amountPaise: payment.amountPaise,
      lateFeePortionPaise: payment.lateFeePortionPaise,
      installmentId: payment.installmentId,
    })),
  };
}
