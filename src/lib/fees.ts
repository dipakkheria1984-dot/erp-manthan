import "server-only";
import { prisma, type Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addMonths, daysBetween, startOfDay } from "@/lib/dates";
import { formatPaise, splitPaise } from "@/lib/money";

/**
 * Fee rules shared by enrollment, promotion and collection.
 *
 * The two rules that drive most of this file:
 *   - Tuition is **rate-locked** to the batch fee effective on the student's
 *     enrollment date and stays there for every subsequent year (spec 2.4).
 *   - Exam and Activity fees are **never** locked — they always apply at the
 *     semester's current value.
 */

/**
 * The batch's preset tuition as of `asOf`. Returns the most recent history row
 * whose `effectiveFrom` is on or before that date.
 */
export async function tuitionRateAt(batchId: string, asOf: Date, db: Db = prisma): Promise<number> {
  const row = await db.batchFeeHistory.findFirst({
    where: { batchId, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: "desc" },
  });
  if (row) return row.tuitionFeePaise;

  // Enrolled before the first revision was recorded — fall back to the earliest
  // known rate rather than charging nothing.
  const earliest = await db.batchFeeHistory.findFirst({
    where: { batchId },
    orderBy: { effectiveFrom: "asc" },
  });
  return earliest?.tuitionFeePaise ?? 0;
}

/** The rate a brand-new enrollment today would be locked to. */
export function currentTuitionRate(batchId: string, db: Db = prisma): Promise<number> {
  return tuitionRateAt(batchId, new Date(), db);
}

export type InstallmentDraft = { seqNo: number; dueDate: Date; amountPaise: number };

/**
 * Spread `totalPayablePaise` over `count` monthly installments starting at
 * `firstDueDate`, with every due date on or before `completionDate` (spec 2.6).
 *
 * When monthly spacing would overrun the completion date the schedule is
 * compressed to fit rather than silently breaking the rule.
 */
export function buildInstallmentPlan({
  totalPayablePaise,
  count,
  firstDueDate,
  completionDate,
}: {
  totalPayablePaise: number;
  count: number;
  firstDueDate: Date;
  completionDate: Date;
}): InstallmentDraft[] {
  if (count < 1) throw new AppError("An installment plan needs at least one installment.");

  const start = startOfDay(firstDueDate);
  const end = startOfDay(completionDate);
  if (start > end) {
    throw new AppError("The first installment is due after the batch completion date.");
  }

  const amounts = splitPaise(totalPayablePaise, count);

  // Monthly by default; fall back to an even spread across the window when the
  // remaining time is too short for monthly spacing.
  const monthlyEnd = addMonths(start, count - 1);
  if (monthlyEnd <= end) {
    return amounts.map((amountPaise, i) => ({
      seqNo: i + 1,
      dueDate: addMonths(start, i),
      amountPaise,
    }));
  }

  const span = daysBetween(start, end);
  return amounts.map((amountPaise, i) => {
    const offset = count === 1 ? 0 : Math.round((span * i) / (count - 1));
    const dueDate = new Date(start);
    dueDate.setDate(dueDate.getDate() + offset);
    return { seqNo: i + 1, dueDate, amountPaise };
  });
}

/**
 * Rules every hand-entered installment plan must satisfy (spec 2.6). Shared by
 * the enrollment fee-plan step and by approval, so a plan that was valid when
 * the Registrar saved it is re-checked before it becomes a real schedule.
 *
 * `minFirstInstallmentPaise` keeps the registration fee inside installment 1 —
 * that money is part of the total fee and is applied to the first installment
 * when the student record is created.
 */
export function validateInstallmentPlan({
  rows,
  totalPayablePaise,
  completionDate,
  minCount,
  maxCount,
  minFirstInstallmentPaise = 0,
}: {
  rows: InstallmentDraft[];
  totalPayablePaise: number;
  completionDate: Date;
  minCount: number;
  maxCount: number;
  minFirstInstallmentPaise?: number;
}): string | null {
  if (rows.length === 0) return "Add at least one installment.";
  if (rows.length < minCount || rows.length > maxCount) {
    return `The plan must have between ${minCount} and ${maxCount} installments.`;
  }
  if (rows.some((row) => row.amountPaise <= 0)) return "Every installment needs an amount above zero.";

  const end = startOfDay(completionDate);
  for (let i = 0; i < rows.length; i += 1) {
    const due = startOfDay(rows[i].dueDate);
    if (due > end) {
      return `Installment ${i + 1} is due after the batch completion date — every due date must fall on or before it.`;
    }
    if (i > 0 && due < startOfDay(rows[i - 1].dueDate)) {
      return "Due dates must run in order, earliest first.";
    }
  }

  const total = rows.reduce((sum, row) => sum + row.amountPaise, 0);
  if (total !== totalPayablePaise) {
    return `The installments add up to ${formatPaise(total)} but the fee for this batch is ${formatPaise(
      totalPayablePaise,
    )}.`;
  }

  if (rows[0].amountPaise < minFirstInstallmentPaise) {
    return `The first installment must be at least ${formatPaise(
      minFirstInstallmentPaise,
    )} — the registration fee collected at enrollment is applied to it.`;
  }

  return null;
}

/**
 * How many installments still fit before `completionDate`, used to warn Admin
 * when a shortened batch completion date cannot hold the remaining plan.
 */
export function installmentsFitting(from: Date, completionDate: Date): number {
  const start = startOfDay(from);
  const end = startOfDay(completionDate);
  if (start > end) return 0;
  let count = 1;
  while (addMonths(start, count) <= end) count += 1;
  return count;
}

/**
 * Compress every unpaid installment due after `newCompletionDate` back inside
 * the window (spec 2.6). Paid and partially paid installments keep their dates —
 * money has already moved against them.
 */
export async function reflowInstallmentsForBatch(
  batchId: string,
  newCompletionDate: Date,
  db: Db = prisma,
): Promise<{ adjusted: number; couldNotFit: number }> {
  const end = startOfDay(newCompletionDate);

  const overrunning = await db.installment.findMany({
    where: {
      dueDate: { gt: end },
      status: { in: ["PENDING", "PARTIALLY_PAID"] },
      feeAssignment: { student: { batchId } },
    },
    orderBy: [{ feeAssignmentId: "asc" }, { seqNo: "asc" }],
  });

  if (overrunning.length === 0) return { adjusted: 0, couldNotFit: 0 };

  // Group by plan so each student's schedule is re-spread coherently.
  const byAssignment = new Map<string, typeof overrunning>();
  for (const installment of overrunning) {
    const list = byAssignment.get(installment.feeAssignmentId) ?? [];
    list.push(installment);
    byAssignment.set(installment.feeAssignmentId, list);
  }

  let adjusted = 0;
  let couldNotFit = 0;
  const today = startOfDay(new Date());

  for (const [, items] of byAssignment) {
    const windowStart = today < end ? today : end;
    const span = daysBetween(windowStart, end);
    if (span < items.length - 1) couldNotFit += 1;

    for (let i = 0; i < items.length; i += 1) {
      const offset = items.length === 1 ? span : Math.round((span * (i + 1)) / items.length);
      const dueDate = new Date(windowStart);
      dueDate.setDate(dueDate.getDate() + Math.max(0, offset));
      await db.installment.update({ where: { id: items[i].id }, data: { dueDate } });
      adjusted += 1;
    }
  }

  return { adjusted, couldNotFit };
}

/**
 * Semesters belonging to a given year of the course. Used to decide whether a
 * promotion crosses into a new academic year and therefore re-triggers tuition
 * (spec 6.4).
 */
export function yearNumberForSemester(semesterNumber: number, totalSemesters: number, durationYears: number): number {
  const perYear = Math.max(1, Math.round(totalSemesters / Math.max(1, durationYears)));
  return Math.min(durationYears, Math.max(1, Math.ceil(semesterNumber / perYear)));
}
