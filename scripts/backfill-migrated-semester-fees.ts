/**
 * Bills the current academic year to students who arrived by bulk import.
 *
 *   npx tsx scripts/backfill-migrated-semester-fees.ts            # dry run, writes nothing
 *   npx tsx scripts/backfill-migrated-semester-fees.ts --apply    # applies it
 *
 * The importer only creates a fee record when a row carries an opening balance
 * (spec 1.8), and nothing else bills a semester to a student who is already
 * enrolled: approval covers new admissions, and a promotion run bills the
 * semester it moves a cohort *into*. A migrated student therefore sits
 * mid-course with no charge against them at all — nothing in the ledger,
 * nothing in Fee Due, nothing to collect against.
 *
 * This closes that gap once, for the students the migration left bare. Both
 * semesters of their current year are assigned, matching how a year is billed
 * everywhere else: tuition at the rate locked to their enrollment date lands on
 * the year's first semester, and each semester carries its own exam and
 * activity fees (spec 2.4, 6.4).
 *
 * Students who came in with an opening balance are left alone — that balance is
 * what they owe, and it already occupies an assignment on their semester.
 *
 * Options:
 *   --installments=N         fixed count per semester (default: monthly, as
 *                            many as fit before the batch completes)
 *   --first-due=YYYY-MM-DD   first due date (default: today)
 *
 * Like its sibling backfills this imports only the generated client: the fee
 * helpers in src/lib are `server-only`, so the few it needs are mirrored below.
 * They are copies of `tuitionRateAt`, `installmentsFitting` and
 * `buildInstallmentPlan` — change them there first, then here.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/* -------------------------------------------------------------------------- */
/* Mirrored helpers — see src/lib/dates.ts, src/lib/money.ts, src/lib/fees.ts  */
/* -------------------------------------------------------------------------- */

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / MS_PER_DAY);
}

function splitPaise(totalPaise: number, count: number): number[] {
  const base = Math.floor(totalPaise / count);
  const remainder = totalPaise - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

type InstallmentDraft = { seqNo: number; dueDate: Date; amountPaise: number };

function buildInstallmentPlan({
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
  const start = startOfDay(firstDueDate);
  const end = startOfDay(completionDate);
  if (start > end) throw new Error("The first installment is due after the batch completion date.");

  const amounts = splitPaise(totalPayablePaise, count);
  const monthlyEnd = addMonths(start, count - 1);
  if (monthlyEnd <= end) {
    return amounts.map((amountPaise, i) => ({ seqNo: i + 1, dueDate: addMonths(start, i), amountPaise }));
  }

  const span = daysBetween(start, end);
  return amounts.map((amountPaise, i) => {
    const offset = count === 1 ? 0 : Math.round((span * i) / (count - 1));
    const dueDate = new Date(start);
    dueDate.setDate(dueDate.getDate() + offset);
    return { seqNo: i + 1, dueDate, amountPaise };
  });
}

function installmentsFitting(from: Date, completionDate: Date): number {
  const start = startOfDay(from);
  const end = startOfDay(completionDate);
  if (start > end) return 0;
  let count = 1;
  while (addMonths(start, count) <= end) count += 1;
  return count;
}

async function tuitionRateAt(batchId: string, asOf: Date): Promise<number> {
  const row = await prisma.batchFeeHistory.findFirst({
    where: { batchId, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: "desc" },
  });
  if (row) return row.tuitionFeePaise;
  const earliest = await prisma.batchFeeHistory.findFirst({
    where: { batchId },
    orderBy: { effectiveFrom: "asc" },
  });
  return earliest?.tuitionFeePaise ?? 0;
}

/* -------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const fixedCountRaw = flag("installments");
const fixedCount = fixedCountRaw ? Number(fixedCountRaw) : null;
const firstDueRaw = flag("first-due");
const firstDue = firstDueRaw ? new Date(`${firstDueRaw}T00:00:00`) : startOfDay(new Date());

const rupees = (paise: number) => (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });
const day = (date: Date) => date.toLocaleDateString("en-GB");

async function main() {
  if (fixedCount !== null && (!Number.isInteger(fixedCount) || fixedCount < 1)) {
    throw new Error("--installments must be a whole number of 1 or more.");
  }
  if (Number.isNaN(firstDue.getTime())) throw new Error("--first-due must be YYYY-MM-DD.");

  const config = await prisma.instituteConfig.findUniqueOrThrow({ where: { id: 1 } });

  // Only the students the migration left with no charge at all. An opening
  // balance already occupies their current semester, and billing on top of it
  // would double what the family owes.
  const students = await prisma.student.findMany({
    where: {
      status: { in: ["ACTIVE", "PASSED"] },
      application: { decisionReason: { contains: "bulk import" } },
      feeAssignments: { none: {} },
    },
    include: { batch: true, currentSemester: true },
    orderBy: { studentCode: "asc" },
  });

  console.log(`${students.length} migrated student(s) carry no fee record.`);
  console.log(`First due ${day(firstDue)} · installments per semester: ${fixedCount ?? "monthly, as many as fit"} (max ${config.installmentMax})`);
  console.log(apply ? "\n--- APPLYING ---\n" : "\n--- DRY RUN, nothing will be written ---\n");

  let assignments = 0;
  let installments = 0;
  let planned = 0;
  const skipped: string[] = [];
  const perBatch = new Map<string, { students: number; paise: number }>();

  for (const student of students) {
    const label = `${student.studentCode} ${student.fullName}`;
    if (!student.currentSemester) {
      skipped.push(`${label} — no current semester`);
      continue;
    }

    // The whole year, not only the semester they happen to be sitting in.
    const yearSemesters = await prisma.semester.findMany({
      where: { batchId: student.batchId, yearNumber: student.currentSemester.yearNumber },
      orderBy: { semesterNumber: "asc" },
    });
    if (yearSemesters.length === 0) {
      skipped.push(`${label} — year ${student.currentSemester.yearNumber} of ${student.batch.code} has no semesters`);
      continue;
    }

    const lockedRate = await tuitionRateAt(student.batchId, student.enrollmentDate);
    if (lockedRate === 0) {
      skipped.push(`${label} — ${student.batch.code} has no tuition rate as of ${day(student.enrollmentDate)}`);
      continue;
    }
    if (startOfDay(firstDue) > startOfDay(student.batch.completionDate)) {
      skipped.push(`${label} — ${student.batch.code} completed ${day(student.batch.completionDate)}, before the first due date`);
      continue;
    }

    let studentTotal = 0;
    const lines: string[] = [];

    for (const [index, semester] of yearSemesters.entries()) {
      // Tuition is a charge on the year, carried by its first semester; later
      // semesters in the same year re-trigger only exam and activity fees.
      const tuition = index === 0 ? lockedRate : 0;
      const total = tuition + semester.examFeePaise + semester.activityFeePaise;

      // Most batches carry no exam or activity fee, so the year's second
      // semester comes to nothing. An empty assignment would only show as a
      // card of zeros on the student record; leaving it out keeps the promotion
      // run free to create it properly when the cohort actually moves there.
      if (total === 0) {
        lines.push(`    sem ${semester.semesterNumber} (year ${semester.yearNumber}) — nothing to bill, skipped`);
        continue;
      }

      const fitting = installmentsFitting(firstDue, student.batch.completionDate);
      const count = Math.max(1, Math.min(fixedCount ?? fitting, config.installmentMax));
      const plan =
        total > 0
          ? buildInstallmentPlan({
              totalPayablePaise: total,
              count,
              firstDueDate: firstDue,
              completionDate: student.batch.completionDate,
            })
          : [];

      assignments += 1;
      installments += plan.length;
      planned += total;
      studentTotal += total;
      lines.push(
        `    sem ${semester.semesterNumber} (year ${semester.yearNumber}) — tuition ${rupees(tuition)}` +
          ` + exam ${rupees(semester.examFeePaise)} + activity ${rupees(semester.activityFeePaise)}` +
          ` = ${rupees(total)} over ${plan.length} installment(s)` +
          (plan.length > 0 ? `, first ${day(plan[0].dueDate)}, last ${day(plan[plan.length - 1].dueDate)}` : ""),
      );

      if (!apply) continue;

      await prisma.$transaction(async (tx) => {
        const assignment = await tx.feeAssignment.upsert({
          where: { studentId_semesterId: { studentId: student.id, semesterId: semester.id } },
          update: {},
          create: {
            studentId: student.id,
            semesterId: semester.id,
            academicYearId: semester.academicYearId,
            yearNumber: semester.yearNumber,
            lockedTuitionRatePaise: tuition,
            tuitionComponentPaise: tuition,
            examFeePaise: semester.examFeePaise,
            activityFeePaise: semester.activityFeePaise,
            totalPayablePaise: total,
            note: "Current-year fee assigned after migration",
          },
        });

        const already = await tx.installment.count({ where: { feeAssignmentId: assignment.id } });
        if (already === 0 && plan.length > 0) {
          await tx.installment.createMany({
            data: plan.map((item) => ({ ...item, feeAssignmentId: assignment.id })),
          });
        }
      });
    }

    const bucket = perBatch.get(student.batch.code) ?? { students: 0, paise: 0 };
    perBatch.set(student.batch.code, { students: bucket.students + 1, paise: bucket.paise + studentTotal });

    console.log(`  ${label} — ${student.batch.code}`);
    for (const line of lines) console.log(line);
  }

  console.log("\nBy batch:");
  for (const [code, bucket] of [...perBatch].sort((a, b) => b[1].paise - a[1].paise)) {
    console.log(`  ${code.padEnd(38)} ${String(bucket.students).padStart(3)} student(s)  ${rupees(bucket.paise).padStart(14)}`);
  }

  console.log(
    `\n${apply ? "Wrote" : "Would write"} ${assignments} assignment(s) and ${installments} installment(s), totalling ${rupees(planned)}.`,
  );
  if (skipped.length > 0) {
    console.log(`\n${skipped.length} student(s) skipped:`);
    for (const line of skipped) console.log(`  ${line}`);
  }
  if (!apply) console.log("\nNothing was written. Re-run with --apply to commit.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
