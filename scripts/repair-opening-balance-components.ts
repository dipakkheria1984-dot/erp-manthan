/**
 * Repairs fee assignments whose money lives only in `totalPayablePaise`.
 *
 *   npx tsx scripts/repair-opening-balance-components.ts            # dry run
 *   npx tsx scripts/repair-opening-balance-components.ts --apply    # applies it
 *
 * The bulk import used to record a migrated student's opening balance as the
 * assignment's total and nothing else, leaving `lockedTuitionRatePaise`,
 * `tuitionComponentPaise`, `examFeePaise` and `activityFeePaise` at zero.
 *
 * Every screen that reads a fee assignment builds the figure back up from those
 * components, so such a row contradicts itself. Two consequences, both visible:
 *
 *   - The student record shows a card of zeros under a total that appears from
 *     nowhere.
 *   - "Edit assigned fee" computes a semester fee of zero and rejects every
 *     save — "the installments add up to X but the fee for this batch is
 *     ₹0.00" — so a migrated student's plan could not be corrected at all.
 *
 * The fix is to say in the components what the row already says in its total:
 * what the old system was owed is tuition owed. `note` keeps the provenance, so
 * nothing is claimed about where the money came from.
 *
 * Only rows that are demonstrably in this state are touched: all four
 * components zero, and installments that add up to more than zero. Anything
 * with a real breakdown is left alone, and the script is safe to re-run.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const apply = process.argv.includes("--apply");
const rupees = (paise: number) => (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 });

async function main() {
  const assignments = await prisma.feeAssignment.findMany({
    where: {
      lockedTuitionRatePaise: 0,
      tuitionComponentPaise: 0,
      examFeePaise: 0,
      activityFeePaise: 0,
      scholarshipAmountPaise: 0,
    },
    include: {
      student: { select: { studentCode: true, fullName: true } },
      semester: { select: { semesterNumber: true } },
      installments: { select: { amountPaise: true, extraChargeKind: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`${assignments.length} fee assignment(s) carry no component breakdown.`);
  console.log(apply ? "\n--- APPLYING ---\n" : "\n--- DRY RUN, nothing will be written ---\n");

  let repaired = 0;
  let skipped = 0;
  let totalPaise = 0;

  for (const assignment of assignments) {
    // Extra charges are separate charges that sit on top of the plan; the
    // semester fee is what the plan itself comes to.
    const planPaise = assignment.installments
      .filter((installment) => installment.extraChargeKind === null)
      .reduce((sum, installment) => sum + installment.amountPaise, 0);
    const extrasPaise = assignment.installments
      .filter((installment) => installment.extraChargeKind !== null)
      .reduce((sum, installment) => sum + installment.amountPaise, 0);

    const label = `${assignment.student.studentCode} ${assignment.student.fullName} — semester ${assignment.semester.semesterNumber}`;

    if (planPaise === 0) {
      skipped += 1;
      console.log(`  SKIP ${label}: no plan installments to take a figure from`);
      continue;
    }

    repaired += 1;
    totalPaise += planPaise;
    console.log(
      `  ${label}: tuition 0 -> ${rupees(planPaise)}` +
        (extrasPaise > 0 ? `, plus ${rupees(extrasPaise)} in extra charges` : "") +
        (assignment.totalPayablePaise !== planPaise + extrasPaise
          ? `  [total was ${rupees(assignment.totalPayablePaise)}, corrected to ${rupees(planPaise + extrasPaise)}]`
          : ""),
    );

    if (!apply) continue;

    await prisma.feeAssignment.update({
      where: { id: assignment.id },
      data: {
        lockedTuitionRatePaise: planPaise,
        tuitionComponentPaise: planPaise,
        // The total has to keep matching what the installments come to.
        totalPayablePaise: planPaise + extrasPaise,
      },
    });
  }

  console.log(
    `\n${apply ? "Repaired" : "Would repair"} ${repaired} assignment(s) totalling ${rupees(totalPaise)}` +
      (skipped > 0 ? `; ${skipped} left alone.` : "."),
  );
  if (!apply) console.log("\nNothing was written. Re-run with --apply to commit.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
