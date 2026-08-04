import "server-only";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { daysBetween, startOfDay } from "@/lib/dates";
import { balanceOf } from "@/lib/late-fees";
import { sendFeeReminder } from "@/lib/notifications";

/**
 * Scheduled reminder pass (spec 3.3).
 *
 * Runs idempotently: a pre-due reminder goes out once per installment, and an
 * overdue reminder only when the Admin-configured recurrence interval has
 * elapsed since the last one. Safe to call more than once a day.
 *
 * Dropped-out and expelled students are excluded (spec 4.5) — their pending
 * installments are waived, and waived installments are skipped anyway.
 */
export async function runReminderPass(asOf: Date = new Date()): Promise<{
  preDueSent: number;
  overdueSent: number;
  failures: number;
  scanned: number;
}> {
  const config = await getConfig();
  const today = startOfDay(asOf);

  const slabs = await prisma.lateFeeSlab.findMany({
    where: { isActive: true },
    orderBy: { minDaysOverdue: "asc" },
  });

  const installments = await prisma.installment.findMany({
    where: {
      status: { in: ["PENDING", "PARTIALLY_PAID"] },
      feeAssignment: { student: { status: { in: ["ACTIVE", "PASSED"] } } },
    },
    include: {
      payments: true,
      feeAssignment: { select: { student: { select: { application: { select: { isProvisional: true } } } } } },
    },
  });

  let preDueSent = 0;
  let overdueSent = 0;
  let failures = 0;

  for (const installment of installments) {
    // A provisional admission accrues no late fee — see balanceOf.
    const balance = balanceOf(
      installment,
      slabs,
      config,
      asOf,
      installment.feeAssignment.student.application.isProvisional,
    );

    // Keep the cached late fee in step so reminders and reports agree.
    if (installment.lateFeePaise !== balance.lateFeeAssessedPaise || installment.status !== balance.status) {
      await prisma.installment.update({
        where: { id: installment.id },
        data: {
          lateFeePaise: balance.lateFeeAssessedPaise,
          status: balance.status,
          lateFeeUpdatedAt: new Date(),
        },
      });
    }
    if (balance.totalOutstandingPaise <= 0) continue;

    const daysUntilDue = daysBetween(today, startOfDay(installment.dueDate));

    if (daysUntilDue === config.preDueReminderDays && config.preDueReminderDays >= 0) {
      const already = await prisma.notificationLog.findFirst({
        where: { installmentId: installment.id, kind: "FEE_PRE_DUE" },
      });
      if (!already) {
        const result = await sendFeeReminder({
          installmentId: installment.id,
          kind: "FEE_PRE_DUE",
          outstandingPaise: balance.principalOutstandingPaise,
          lateFeePaise: balance.lateFeeOutstandingPaise,
          dueDate: installment.dueDate,
        });
        preDueSent += result.sent;
        failures += result.failed;
      }
      continue;
    }

    if (balance.daysOverdue > 0) {
      const last = await prisma.notificationLog.findFirst({
        where: { installmentId: installment.id, kind: "FEE_OVERDUE" },
        orderBy: { createdAt: "desc" },
      });
      const due =
        !last || daysBetween(startOfDay(last.createdAt), today) >= config.overdueReminderIntervalDays;
      if (due) {
        const result = await sendFeeReminder({
          installmentId: installment.id,
          kind: "FEE_OVERDUE",
          outstandingPaise: balance.principalOutstandingPaise,
          lateFeePaise: balance.lateFeeOutstandingPaise,
          dueDate: installment.dueDate,
        });
        overdueSent += result.sent;
        failures += result.failed;
      }
    }
  }

  await prisma.reminderRun.create({
    data: { preDueSent, overdueSent, failures, notes: `Scanned ${installments.length} open installment(s).` },
  });

  return { preDueSent, overdueSent, failures, scanned: installments.length };
}
