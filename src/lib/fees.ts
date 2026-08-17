import "server-only";
import { prisma, type Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addMonths, daysBetween, fromDateInput, startOfDay } from "@/lib/dates";
import { formatPaise, rupeesToPaise, splitPaise } from "@/lib/money";

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

/**
 * What a new admission into this batch must register with — the amount that is
 * installment 1, and the amount an admission stays provisional until it clears.
 *
 * Kept as one pure function because five places need the same answer: the fee
 * plan, the collection screen, the submission gate, the approval, and the two
 * halves of the provisional rule. Any of them reading the institute minimum
 * directly would quietly disagree with the batch a student is actually in.
 *
 * A batch with no figure of its own predates this being settable and falls back
 * to the institute minimum. Where a batch does carry one it may not be below
 * that minimum — the batch form refuses it — so taking the larger here is a
 * guard against an older row rather than routine behaviour.
 */
export function registrationFeeFor(
  batch: { registrationFeePaise: number | null },
  config: { minRegistrationFeePaise: number },
): number {
  if (batch.registrationFeePaise === null) return config.minRegistrationFeePaise;
  return Math.max(batch.registrationFeePaise, config.minRegistrationFeePaise);
}

/**
 * The registration fee to quote an applicant who has chosen a course but not a
 * batch — the online admission form, where the batch is the office's to set.
 *
 * The figure comes from the batch they would most likely land in: open
 * (upcoming or ongoing), still holding a free seat, and starting soonest.
 * Where a course has several such batches at different fees this picks one of
 * them, so the amount is quoted as indicative and the batch it came from is
 * named on screen — the office sets the real batch, and the balance either way
 * is collected at the counter.
 *
 * `null` when the course has no open batch at all: there is then no honest
 * figure to quote, and the caller falls back to the institute minimum.
 */
export async function registrationFeeForCourse(
  courseId: string,
  config: { minRegistrationFeePaise: number },
  db: Db = prisma,
): Promise<{ amountPaise: number; batchName: string | null }> {
  const batches = await db.batch.findMany({
    where: { courseId, status: { in: ["UPCOMING", "ONGOING"] } },
    include: { _count: { select: { students: true } } },
    orderBy: { startDate: "asc" },
  });

  const open = batches.find((batch) => batch._count.students < batch.totalSeats);
  if (!open) return { amountPaise: config.minRegistrationFeePaise, batchName: null };
  return { amountPaise: registrationFeeFor(open, config), batchName: open.name };
}

export type InstallmentDraft = { seqNo: number; dueDate: Date; amountPaise: number };

/** One row as the installment editors post it. `id` is empty on a new row. */
export type PlanRowInput = { id: string; dueDate: Date; amountPaise: number };

/**
 * Parse the JSON an installment editor posts — `[{ id?, dueDate, amount }]` —
 * or say which row is wrong.
 *
 * Every screen that lets someone lay out a schedule by hand sends the same
 * shape: correcting an assigned fee, filling a gap for an imported student, and
 * billing the course a student has moved to.
 */
export function parsePlanRows(raw: string): { rows: PlanRowInput[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "The installment rows could not be read. Reload the page and try again." };
  }
  if (!Array.isArray(parsed)) return { error: "The installment rows could not be read." };

  const rows: PlanRowInput[] = [];
  for (const [index, entry] of parsed.entries()) {
    const row = entry as { id?: unknown; dueDate?: unknown; amount?: unknown };
    const dueDate = fromDateInput(String(row.dueDate ?? ""));
    if (Number.isNaN(dueDate.getTime())) return { error: `Installment ${index + 1} needs a due date.` };

    const cleaned = String(row.amount ?? "").trim().replace(/[,\s₹]/g, "");
    const amount = Number(cleaned);
    if (cleaned === "" || !Number.isFinite(amount)) {
      return { error: `Installment ${index + 1} needs an amount.` };
    }
    rows.push({ id: typeof row.id === "string" ? row.id : "", dueDate, amountPaise: rupeesToPaise(amount) });
  }
  return { rows };
}

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
  firstInstallmentPaise,
}: {
  rows: InstallmentDraft[];
  totalPayablePaise: number;
  completionDate: Date;
  minCount: number;
  maxCount: number;
  minFirstInstallmentPaise?: number;
  /**
   * The batch's registration fee, where the batch sets one. Installment 1 is
   * that amount exactly — not a floor — because the two are the same charge
   * seen from two directions, and an installment 1 larger than the registration
   * fee would leave an admission confirmed with money still owed on it.
   */
  firstInstallmentPaise?: number;
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

  if (firstInstallmentPaise !== undefined && rows[0].amountPaise !== firstInstallmentPaise) {
    return `The first installment must be exactly ${formatPaise(
      firstInstallmentPaise,
    )} — this batch's registration fee. Change the registration fee on the batch to alter it.`;
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

  /*
   * Every plan is re-spread across the same window by the same rule, so the
   * dates that come out repeat heavily from one student to the next. Grouping
   * by the date lands a whole batch in a handful of statements: shortening a
   * completion date can touch hundreds of installments, and a write apiece —
   * inside the transaction that is changing the batch — was more than it could
   * hold.
   */
  const byNewDate = new Map<number, string[]>();

  for (const [, items] of byAssignment) {
    const windowStart = today < end ? today : end;
    const span = daysBetween(windowStart, end);
    if (span < items.length - 1) couldNotFit += 1;

    for (let i = 0; i < items.length; i += 1) {
      const offset = items.length === 1 ? span : Math.round((span * (i + 1)) / items.length);
      const dueDate = new Date(windowStart);
      dueDate.setDate(dueDate.getDate() + Math.max(0, offset));
      const key = dueDate.getTime();
      byNewDate.set(key, [...(byNewDate.get(key) ?? []), items[i].id]);
      adjusted += 1;
    }
  }

  for (const [time, ids] of byNewDate) {
    await db.installment.updateMany({ where: { id: { in: ids } }, data: { dueDate: new Date(time) } });
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
