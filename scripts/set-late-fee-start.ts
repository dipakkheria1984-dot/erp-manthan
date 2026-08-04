/**
 * Set the day the late fee policy starts counting, and re-price every unpaid
 * installment against it.
 *
 *   npx tsx scripts/set-late-fee-start.ts 2026-08-01
 *   npx tsx scripts/set-late-fee-start.ts 2026-08-01 --dry-run
 *   npx tsx scripts/set-late-fee-start.ts --clear
 *
 * Nothing accrues for time before that date, so an institute adopting the
 * policy — or forgiving everything up to a day — sets it here and every
 * outstanding late fee is recomputed from that day forward. Fees already
 * *collected* are not touched: that money is with the institute, and handing it
 * back is a per-student decision (waive the late fee on the student's record,
 * which credits it against what they owe next).
 *
 * Safe to re-run. `--dry-run` reports what would change and writes nothing.
 */
import "dotenv/config";
import Module from "node:module";

const req = Module.createRequire(__filename);
require.cache[req.resolve("server-only")] = { exports: {}, loaded: true } as never;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const clear = args.includes("--clear");
  const dateArg = args.find((arg) => !arg.startsWith("--"));

  if (!clear && !dateArg) {
    throw new Error("Pass a date (yyyy-MM-dd), or --clear to charge from every due date again.");
  }

  const { prisma } = await import("../src/lib/db");
  const { balanceOf, refreshInstallment } = await import("../src/lib/late-fees");
  const { fromDateInput, formatDate } = await import("../src/lib/dates");
  const { formatPaise } = await import("../src/lib/money");

  const effectiveFrom = clear ? null : fromDateInput(dateArg!);
  if (effectiveFrom && Number.isNaN(effectiveFrom.getTime())) {
    throw new Error(`"${dateArg}" is not a date. Use yyyy-MM-dd.`);
  }

  const before = await prisma.instituteConfig.findUniqueOrThrow({ where: { id: 1 } });
  console.log(
    `late fee start: ${before.lateFeeEffectiveFrom ? formatDate(before.lateFeeEffectiveFrom) : "not set"} -> ${
      effectiveFrom ? formatDate(effectiveFrom) : "not set"
    } | grace ${before.lateFeeGraceDays} day(s)`,
  );

  if (!dryRun) {
    await prisma.instituteConfig.update({ where: { id: 1 }, data: { lateFeeEffectiveFrom: effectiveFrom } });
  }

  const config = { ...before, lateFeeEffectiveFrom: effectiveFrom };
  const slabs = await prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } });

  // Every installment that is carrying a late fee now, or would be re-priced by
  // the change. Waived ones are left alone — they are already written off.
  const installments = await prisma.installment.findMany({
    where: { status: { not: "WAIVED" } },
    include: {
      payments: true,
      feeAssignment: {
        select: {
          student: {
            select: { id: true, studentCode: true, application: { select: { isProvisional: true } } },
          },
        },
      },
    },
    orderBy: { dueDate: "asc" },
  });

  let changed = 0;
  let clearedPaise = 0;
  let addedPaise = 0;
  const students = new Set<string>();

  for (const installment of installments) {
    const exempt = installment.feeAssignment.student.application.isProvisional;
    const balance = balanceOf(installment, slabs, config, new Date(), exempt);
    if (balance.lateFeeAssessedPaise === installment.lateFeePaise) continue;

    const delta = balance.lateFeeAssessedPaise - installment.lateFeePaise;
    if (delta < 0) clearedPaise += -delta;
    else addedPaise += delta;
    changed += 1;
    students.add(installment.feeAssignment.student.studentCode);

    if (!dryRun) await refreshInstallment(installment.id, prisma);
  }

  console.log(
    `${installments.length} live installment(s) checked | ${changed} re-priced across ${students.size} student(s)`,
  );
  console.log(`late fee removed: ${formatPaise(clearedPaise)} | late fee added: ${formatPaise(addedPaise)}`);

  // What is still charged after the change, and what has already been collected
  // — the collected figure is the part this script deliberately does not touch.
  const after = await prisma.installment.aggregate({
    where: { status: { not: "WAIVED" } },
    _sum: { lateFeePaise: true },
  });
  const collected = await prisma.payment.aggregate({
    where: { status: "ACTIVE" },
    _sum: { lateFeePortionPaise: true },
  });
  console.log(
    `${dryRun ? "late fee charged now (unchanged by this run)" : "late fee still charged"}: ${formatPaise(
      after._sum.lateFeePaise ?? 0,
    )} | already collected (untouched either way): ${formatPaise(collected._sum.lateFeePortionPaise ?? 0)}`,
  );
  if (dryRun) console.log("dry run — nothing was written.");

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
