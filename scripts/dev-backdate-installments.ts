/**
 * Dev helper: backdate a student's first installment so late-fee slabs and the
 * overdue reminder path can be exercised without waiting for real time to pass,
 * and pull the second installment to exactly the pre-due reminder window.
 *
 * Usage: npx tsx scripts/dev-backdate-installments.ts STU10001
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function daysFromToday(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

async function main() {
  const studentCode = process.argv[2];
  if (!studentCode) throw new Error("Pass a student code, e.g. STU10001");

  const student = await prisma.student.findUniqueOrThrow({ where: { studentCode } });
  const config = await prisma.instituteConfig.findUniqueOrThrow({ where: { id: 1 } });

  const installments = await prisma.installment.findMany({
    where: { feeAssignment: { studentId: student.id } },
    orderBy: [{ feeAssignmentId: "asc" }, { seqNo: "asc" }],
  });
  if (installments.length < 2) throw new Error("Need at least two installments.");

  // 20 days overdue lands in the 16–30 day slab.
  await prisma.installment.update({
    where: { id: installments[0].id },
    data: { dueDate: daysFromToday(-20) },
  });
  // Exactly the configured pre-due window, so the pre-due reminder fires today.
  await prisma.installment.update({
    where: { id: installments[1].id },
    data: { dueDate: daysFromToday(config.preDueReminderDays) },
  });

  console.log(
    `Installment 1 → 20 days overdue; installment 2 → due in ${config.preDueReminderDays} days (pre-due window).`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
