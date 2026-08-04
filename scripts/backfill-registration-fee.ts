/**
 * One-off migration for records created before the registration fee stopped
 * being deducted from the assigned fee.
 *
 *   npx tsx scripts/backfill-registration-fee.ts            # dry run, writes nothing
 *   npx tsx scripts/backfill-registration-fee.ts --apply    # applies the fix
 *
 * Old behaviour: FeeAssignment.totalPayablePaise was tuition + exam + activity
 * MINUS whatever registration fee had been collected, and the registration
 * receipts were left unlinked to any installment.
 *
 * Correct behaviour: the total is the sum of the fee heads, the registration
 * receipts are payments against installment 1, and installment 1 carries the
 * amount that was previously netted off.
 *
 * The fix is cash-neutral — installment 1 goes up by exactly the registration
 * amount that is simultaneously credited against it, so nobody owes a rupee
 * more or less than before.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const apply = process.argv.includes("--apply");
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

type Verdict = "FIX" | "REVIEW" | "OK";

async function main() {
  const assignments = await prisma.feeAssignment.findMany({
    include: {
      semester: { select: { semesterNumber: true } },
      student: {
        select: {
          id: true,
          studentCode: true,
          fullName: true,
          payments: {
            where: { kind: "REGISTRATION" },
            select: { id: true, amountPaise: true, status: true, installmentId: true },
          },
        },
      },
      installments: { orderBy: { seqNo: "asc" }, include: { payments: { select: { id: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  let fixable = 0;
  let review = 0;

  for (const assignment of assignments) {
    // Migrated opening balances are lump sums by design, not fee heads.
    if (assignment.note) continue;

    const heads =
      assignment.tuitionComponentPaise + assignment.examFeePaise + assignment.activityFeePaise;
    const shortfall = heads - assignment.totalPayablePaise;
    if (shortfall === 0) continue;

    const registrationActive = assignment.student.payments
      .filter((payment) => payment.status === "ACTIVE")
      .reduce((sum, payment) => sum + payment.amountPaise, 0);
    const first = assignment.installments[0];
    const installmentSum = assignment.installments.reduce((sum, row) => sum + row.amountPaise, 0);

    const reasons: string[] = [];
    if (shortfall < 0) reasons.push("assignment total is HIGHER than its fee heads — not the known legacy case");
    if (assignment.student.payments.some((payment) => payment.status === "ACTIVE" && payment.installmentId)) {
      // Already credited against an installment; raising the amount as well
      // would bill the registration money twice.
      reasons.push("a registration receipt is already applied to an installment");
    }
    if (shortfall !== registrationActive) {
      reasons.push(
        `shortfall ${rupees(shortfall)} does not match the active registration receipts ${rupees(registrationActive)}`,
      );
    }
    if (!first) reasons.push("no installments to carry the amount");
    if (first?.status === "WAIVED") reasons.push("installment 1 is waived — raising it would change the waiver");
    if (installmentSum !== assignment.totalPayablePaise) {
      reasons.push(
        `installments (${rupees(installmentSum)}) already differ from the assignment total (${rupees(assignment.totalPayablePaise)})`,
      );
    }

    const verdict: Verdict = reasons.length === 0 ? "FIX" : "REVIEW";
    if (verdict === "FIX") fixable += 1;
    else review += 1;

    console.log(
      [
        `${verdict}  ${assignment.student.studentCode} ${assignment.student.fullName} — semester ${assignment.semester.semesterNumber}`,
        `      assigned total ${rupees(assignment.totalPayablePaise)} → ${rupees(heads)}   (tuition ${rupees(
          assignment.tuitionComponentPaise,
        )} + exam ${rupees(assignment.examFeePaise)} + activity ${rupees(assignment.activityFeePaise)})`,
        first
          ? `      installment 1 ${rupees(first.amountPaise)} → ${rupees(first.amountPaise + shortfall)}, ` +
            `linking ${assignment.student.payments.filter((p) => p.status === "ACTIVE").length} registration receipt(s) worth ${rupees(registrationActive)}`
          : "      no installments",
        ...reasons.map((reason) => `      ! ${reason}`),
      ].join("\n"),
    );

    if (verdict !== "FIX" || !apply || !first) continue;

    await prisma.$transaction(async (tx) => {
      await tx.feeAssignment.update({
        where: { id: assignment.id },
        data: { totalPayablePaise: heads },
      });
      await tx.installment.update({
        where: { id: first.id },
        data: { amountPaise: first.amountPaise + shortfall },
      });
      await tx.payment.updateMany({
        where: { studentId: assignment.student.id, kind: "REGISTRATION", status: "ACTIVE" },
        data: { installmentId: first.id },
      });
    });
  }

  console.log(
    `\n${apply ? "Applied" : "Dry run"} — ${fixable} assignment(s) ${apply ? "corrected" : "would be corrected"}, ` +
      `${review} need a look by hand, out of ${assignments.length} scanned.`,
  );
  if (!apply && fixable > 0) console.log("Re-run with --apply to write these changes.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
