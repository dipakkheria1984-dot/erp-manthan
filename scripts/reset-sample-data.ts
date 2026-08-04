/**
 * Clears the sample dataset so real data can be loaded into a clean app.
 *
 *   npx tsx scripts/reset-sample-data.ts            # dry run, writes nothing
 *   npx tsx scripts/reset-sample-data.ts --apply    # deletes
 *
 * Removed: every student and application record, everything hanging off them
 * (guardians, documents, fee assignments, installments, payments, discounts,
 * status history), the promotion and reminder runs, notification logs, the
 * academic structure — departments, courses, batches, their fee history and
 * semesters — and the audit log, which for a sample dataset is only the trail
 * of the sample being built.
 *
 * Kept: users, roles and sessions, so the login still works; institute and
 * communication setup; late fee slabs, document requirements and terms
 * versions.
 *
 * The LF No counter goes back to the schema default so real students number
 * from the start, and the receipt and application counters reset with it —
 * every receipt and application they counted is being deleted here.
 *
 * Deletion runs in one transaction in foreign-key order: a mistake in that
 * order aborts the whole thing rather than leaving the database half-cleared.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const apply = process.argv.includes("--apply");

const LF_NO_START = 10001;

/** Children before parents. */
const ORDER = [
  "auditLog",
  "promotionRunStudent",
  "promotionRun",
  "reminderRun",
  "notificationLog",
  "discount",
  "payment",
  "installment",
  "feeAssignment",
  "studentStatusHistory",
  "student",
  "applicationDocument",
  "applicationInstallment",
  "guardian",
  "application",
  "semester",
  "batchFeeHistory",
  "batch",
  "course",
  "department",
  "academicYear",
] as const;

const KEPT = [
  "user",
  "role",
  "session",
  "institute",
  "instituteConfig",
  "communicationConfig",
  "lateFeeSlab",
  "documentRequirement",
  "termsVersion",
] as const;

async function main() {
  const client = prisma as unknown as Record<string, { count: () => Promise<number>; deleteMany: () => Promise<{ count: number }> }>;

  console.log("To delete:");
  let total = 0;
  for (const model of ORDER) {
    const n = await client[model].count();
    total += n;
    if (n > 0) console.log(`  ${model.padEnd(24)} ${String(n).padStart(5)}`);
  }
  console.log(`  ${"".padEnd(24)} ${String(total).padStart(5)} row(s)\n`);

  console.log("Kept:");
  for (const model of KEPT) {
    const n = await client[model].count();
    if (n > 0) console.log(`  ${model.padEnd(24)} ${String(n).padStart(5)}`);
  }

  const config = await prisma.instituteConfig.findUnique({ where: { id: 1 }, select: { lfNoNext: true } });
  const sequences = await prisma.sequence.findMany({ select: { key: true, nextValue: true } });
  console.log(`\nCounters: lfNoNext ${config?.lfNoNext} -> ${LF_NO_START}`);
  for (const seq of sequences) console.log(`          ${seq.key} ${seq.nextValue} -> 1`);

  if (!apply) {
    console.log("\n--- DRY RUN --- nothing was deleted. Re-run with --apply.");
    return;
  }

  console.log("\n--- DELETING ---");
  await prisma.$transaction(async (tx) => {
    const scoped = tx as unknown as Record<string, { deleteMany: () => Promise<{ count: number }> }>;
    for (const model of ORDER) {
      const { count } = await scoped[model].deleteMany();
      if (count > 0) console.log(`  ${model.padEnd(24)} ${String(count).padStart(5)} deleted`);
    }
    await tx.instituteConfig.updateMany({ data: { lfNoNext: LF_NO_START } });
    await tx.sequence.updateMany({ data: { nextValue: 1 } });
  });

  console.log("\nDone. Counters reset.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
