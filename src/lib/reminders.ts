import "server-only";
import { prisma } from "@/lib/db";
import { getConfig, getInstitute } from "@/lib/config";
import { daysBetween, startOfDay } from "@/lib/dates";
import { balanceOf, refreshInstallmentsBulk } from "@/lib/late-fees";
import { resolveChannels, sendFeeReminder, type FeeReminderTarget } from "@/lib/notifications";

/**
 * Scheduled reminder pass (spec 3.3).
 *
 * Runs idempotently: a pre-due reminder goes out once per installment, and an
 * overdue reminder only when the Admin-configured recurrence interval has
 * elapsed since the last one. Safe to call more than once a day.
 *
 * Dropped-out and expelled students are excluded (spec 4.5) — their pending
 * installments are waived, and waived installments are skipped anyway.
 *
 * ## Reaching everyone
 *
 * The job has a fixed number of seconds (`maxDuration` on the route, capped at
 * 60 by the hosting plan) to reach every student who is owed a reminder, and
 * whatever it does not get to is not queued anywhere — it simply does not go
 * out. So the pass is built to spend its budget on sending rather than on round
 * trips:
 *
 *  - the cached late fee and status are written for every installment in a
 *    handful of grouped statements, not one `update` each;
 *  - the notification history is read in two queries up front, not a `findFirst`
 *    per installment;
 *  - the provider pair, the institute and the recipient rows are resolved once
 *    and passed down, so a send is a send.
 *
 * What is left is the messages themselves, and those are ordered by due date so
 * the most overdue are served first. If the budget still runs out the pass stops
 * cleanly and says so on the run record, rather than being killed mid-flight and
 * leaving no trace of how far it got.
 */

/**
 * When to stop starting new messages, as a fraction of the wall clock the caller
 * says it has. The margin covers the message in flight plus writing the run row.
 */
const BUDGET_SPEND = 0.8;

export type ReminderPassResult = {
  /**
   * Deliveries, not reminders: every reminder goes out on Email *and* WhatsApp
   * (spec 3.3), so one reminder counts two here. `skippedForTime` below counts
   * reminders — it is the messages that were never built, not deliveries that
   * were never attempted.
   */
  preDueSent: number;
  overdueSent: number;
  failures: number;
  scanned: number;
  /** Reminders that were due but not attempted because the budget ran out. */
  skippedForTime: number;
  /** False when `skippedForTime` is non-zero. */
  completed: boolean;
};

export async function runReminderPass(
  asOf: Date = new Date(),
  /** Wall clock the pass may use. Defaults to the route's 60s ceiling. */
  budgetMs = 60_000,
): Promise<ReminderPassResult> {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs * BUDGET_SPEND;

  const [config, institute, channels] = await Promise.all([
    getConfig(),
    getInstitute().catch(() => null),
    resolveChannels(),
  ]);
  const instituteName = institute?.name ?? "the institute";
  const today = startOfDay(asOf);

  const slabs = await prisma.lateFeeSlab.findMany({
    where: { isActive: true },
    orderBy: { minDaysOverdue: "asc" },
  });

  // Ordered by due date so that a pass which cannot finish has still served the
  // students who have been waiting longest, rather than an arbitrary slice of
  // the table that happens to come back first every night.
  const installments = await prisma.installment.findMany({
    where: {
      status: { in: ["PENDING", "PARTIALLY_PAID"] },
      feeAssignment: { student: { status: { in: ["ACTIVE", "PASSED"] } } },
    },
    include: {
      payments: true,
      feeAssignment: {
        select: {
          student: {
            select: {
              id: true,
              fullName: true,
              studentCode: true,
              email: true,
              phone: true,
              application: {
                select: {
                  isProvisional: true,
                  guardians: {
                    where: { isPrimary: true },
                    take: 1,
                    select: { email: true, phone: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { dueDate: "asc" },
  });

  /** An installment that needs a message, with everything the send will want. */
  type Candidate = {
    kind: "FEE_PRE_DUE" | "FEE_OVERDUE";
    target: FeeReminderTarget;
    outstandingPaise: number;
    lateFeePaise: number;
  };

  const preDueCandidates: Candidate[] = [];
  const overdueCandidates: Candidate[] = [];

  for (const installment of installments) {
    const student = installment.feeAssignment.student;
    // A provisional admission accrues no late fee — see balanceOf.
    const balance = balanceOf(installment, slabs, config, asOf, student.application.isProvisional);
    if (balance.totalOutstandingPaise <= 0) continue;

    const target: FeeReminderTarget = {
      installmentId: installment.id,
      seqNo: installment.seqNo,
      dueDate: installment.dueDate,
      student: {
        id: student.id,
        fullName: student.fullName,
        studentCode: student.studentCode,
        email: student.email,
        phone: student.phone,
        guardian: student.application.guardians[0] ?? null,
      },
    };
    const common = {
      target,
      outstandingPaise: balance.principalOutstandingPaise,
      lateFeePaise: balance.lateFeeOutstandingPaise,
    };

    const daysUntilDue = daysBetween(today, startOfDay(installment.dueDate));

    // The whole window, not the single day that lands exactly N days out. On the
    // exact-day test a pass that was truncated, failed, or simply did not run on
    // that one date lost the pre-due reminder for good, and an installment
    // raised inside the window never qualified at all. Sent once per
    // installment either way — the notification log is what enforces that.
    if (config.preDueReminderDays >= 0 && daysUntilDue >= 0 && daysUntilDue <= config.preDueReminderDays) {
      preDueCandidates.push({ ...common, kind: "FEE_PRE_DUE" });
      continue;
    }

    if (balance.daysOverdue > 0) {
      overdueCandidates.push({ ...common, kind: "FEE_OVERDUE" });
    }
  }

  // Keep the cached late fee in step so reminders and reports agree. Grouped by
  // outcome, so this is a few statements rather than one per installment.
  await refreshInstallmentsBulk(
    installments.map((installment) => ({
      installment,
      asOf,
      lateFeeExempt: installment.feeAssignment.student.application.isProvisional,
    })),
    slabs,
    config,
  );

  // The notification history, in two queries rather than one per installment.
  const [preDueAlready, overdueLast] = await Promise.all([
    preDueCandidates.length > 0
      ? prisma.notificationLog.findMany({
          where: {
            kind: "FEE_PRE_DUE",
            installmentId: { in: preDueCandidates.map((c) => c.target.installmentId) },
          },
          select: { installmentId: true },
          distinct: ["installmentId"],
        })
      : [],
    overdueCandidates.length > 0
      ? prisma.notificationLog.groupBy({
          by: ["installmentId"],
          where: {
            kind: "FEE_OVERDUE",
            installmentId: { in: overdueCandidates.map((c) => c.target.installmentId) },
          },
          _max: { createdAt: true },
        })
      : [],
  ]);

  const preDueSentAlready = new Set(preDueAlready.map((row) => row.installmentId));
  const lastOverdueAt = new Map(
    overdueLast.map((row) => [row.installmentId, row._max.createdAt] as const),
  );

  const queue = [
    ...preDueCandidates.filter((c) => !preDueSentAlready.has(c.target.installmentId)),
    ...overdueCandidates.filter((c) => {
      const last = lastOverdueAt.get(c.target.installmentId);
      return !last || daysBetween(startOfDay(last), today) >= config.overdueReminderIntervalDays;
    }),
  ];

  let preDueSent = 0;
  let overdueSent = 0;
  let failures = 0;
  let skippedForTime = 0;

  for (const [index, candidate] of queue.entries()) {
    if (Date.now() >= deadline) {
      skippedForTime = queue.length - index;
      break;
    }

    const result = await sendFeeReminder({
      target: candidate.target,
      kind: candidate.kind,
      outstandingPaise: candidate.outstandingPaise,
      lateFeePaise: candidate.lateFeePaise,
      instituteName,
      channels,
    });

    if (candidate.kind === "FEE_PRE_DUE") preDueSent += result.sent;
    else overdueSent += result.sent;
    failures += result.failed;
  }

  const notes =
    `Scanned ${installments.length} open installment(s); ${queue.length} reminder(s) due.` +
    (skippedForTime > 0
      ? ` Ran out of time with ${skippedForTime} still to send — they are picked up by the next pass.`
      : "") +
    ` Took ${Math.round((Date.now() - startedAt) / 1000)}s.`;

  await prisma.reminderRun.create({
    data: { preDueSent, overdueSent, failures, notes },
  });

  return {
    preDueSent,
    overdueSent,
    failures,
    scanned: installments.length,
    skippedForTime,
    completed: skippedForTime === 0,
  };
}
