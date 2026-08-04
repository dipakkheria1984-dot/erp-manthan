/**
 * Hand back every late fee that has already been collected, as a credit against
 * what each student owes next.
 *
 *   npx tsx scripts/credit-collected-late-fees.ts --dry-run
 *   npx tsx scripts/credit-collected-late-fees.ts
 *
 * The companion to `set-late-fee-start.ts`: that one stops the past being
 * *charged*, this one gives back what was already *paid*. No cash moves and no
 * receipt is altered — for each installment whose late fee was collected, the
 * amount becomes a `LATE_FEE_ADJUSTMENT` credit on that student's unpaid
 * installments, oldest first, exactly as waiving one late fee from the student
 * record does. Their next payment is smaller by that much.
 *
 * A credit needs somewhere to land. Where a student has nothing left owing, the
 * money cannot be handed back this way and the script lists them: those are
 * real refunds, handled outside the system.
 *
 * Safe to re-run — an already-credited fee is skipped.
 */
import "dotenv/config";
import Module from "node:module";

const req = Module.createRequire(__filename);
require.cache[req.resolve("server-only")] = { exports: {}, loaded: true } as never;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const reason = "Late fee waived institute-wide; policy applies from 01 Aug 2026.";

  const { prisma } = await import("../src/lib/db");
  const { refreshInstallment } = await import("../src/lib/late-fees");
  const { formatDate } = await import("../src/lib/dates");
  const { formatPaise } = await import("../src/lib/money");

  const students = await prisma.student.findMany({
    where: { feeAssignments: { some: { installments: { some: { payments: { some: { lateFeePortionPaise: { gt: 0 } } } } } } } },
    select: {
      id: true,
      studentCode: true,
      fullName: true,
      feeAssignments: {
        select: {
          semester: { select: { semesterNumber: true } },
          installments: {
            orderBy: [{ dueDate: "asc" }, { seqNo: "asc" }],
            select: {
              id: true,
              seqNo: true,
              dueDate: true,
              amountPaise: true,
              status: true,
              lateFeeCreditedPaise: true,
              lateFeeWaived: true,
              payments: { select: { status: true, amountPaise: true, lateFeePortionPaise: true } },
              discounts: { where: { cancelledAt: null }, select: { amountPaise: true } },
            },
          },
        },
      },
    },
    orderBy: { studentCode: "asc" },
  });

  let creditedTotal = 0;
  let creditedStudents = 0;
  let creditRows = 0;
  const shortfalls: { code: string; name: string; paise: number }[] = [];

  for (const student of students) {
    const installments = student.feeAssignments
      .flatMap((assignment) =>
        assignment.installments.map((installment) => ({
          ...installment,
          semesterNumber: assignment.semester.semesterNumber,
        })),
      )
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.seqNo - b.seqNo);

    // What was collected as late fee and not yet handed back.
    const sources = installments
      .map((installment) => {
        const paid = installment.payments
          .filter((p) => p.status === "ACTIVE")
          .reduce((sum, p) => sum + p.lateFeePortionPaise, 0);
        return { installment, collectedPaise: Math.max(0, paid - installment.lateFeeCreditedPaise) };
      })
      .filter((source) => source.collectedPaise > 0);
    if (sources.length === 0) continue;

    // Where a credit can go: what is still chargeable on each unpaid installment.
    const room = new Map<string, number>();
    for (const installment of installments) {
      if (installment.status === "PAID" || installment.status === "WAIVED") continue;
      const discounted = installment.discounts.reduce((sum, d) => sum + d.amountPaise, 0);
      const paidPrincipal = installment.payments
        .filter((p) => p.status === "ACTIVE")
        .reduce((sum, p) => sum + (p.amountPaise - p.lateFeePortionPaise), 0);
      const left = installment.amountPaise - discounted - paidPrincipal;
      if (left > 0) room.set(installment.id, left);
    }

    const plan: { sourceId: string; targetId: string; amountPaise: number }[] = [];
    let studentShortfall = 0;

    for (const source of sources) {
      let remaining = source.collectedPaise;
      for (const installment of installments) {
        if (remaining <= 0) break;
        const available = room.get(installment.id) ?? 0;
        if (available <= 0) continue;
        const share = Math.min(remaining, available);
        plan.push({ sourceId: source.installment.id, targetId: installment.id, amountPaise: share });
        room.set(installment.id, available - share);
        remaining -= share;
      }
      if (remaining > 0) studentShortfall += remaining;
    }

    if (studentShortfall > 0) {
      shortfalls.push({ code: student.studentCode, name: student.fullName, paise: studentShortfall });
    }
    if (plan.length === 0) continue;

    const studentCredited = plan.reduce((sum, entry) => sum + entry.amountPaise, 0);
    creditedTotal += studentCredited;
    creditedStudents += 1;
    creditRows += plan.length;

    console.log(
      `${student.studentCode}: crediting ${formatPaise(studentCredited)} across ${plan.length} installment(s)` +
        (studentShortfall > 0 ? ` — ${formatPaise(studentShortfall)} has nowhere to go` : ""),
    );

    if (dryRun) continue;

    await prisma.$transaction(async (tx) => {
      const bySource = new Map<string, number>();
      for (const entry of plan) {
        const source = sources.find((candidate) => candidate.installment.id === entry.sourceId)!;
        await tx.discount.create({
          data: {
            installmentId: entry.targetId,
            lateFeeSourceInstallmentId: entry.sourceId,
            studentId: student.id,
            reason: "LATE_FEE_ADJUSTMENT",
            amountPaise: entry.amountPaise,
            note:
              `Late fee of ${formatPaise(source.collectedPaise)} collected against the installment due ` +
              `${formatDate(source.installment.dueDate)} was waived. Adjusted here instead of being refunded. ${reason}`,
          },
        });
        bySource.set(entry.sourceId, (bySource.get(entry.sourceId) ?? 0) + entry.amountPaise);
      }

      for (const [sourceId, amountPaise] of bySource) {
        const source = sources.find((candidate) => candidate.installment.id === sourceId)!;
        await tx.installment.update({
          where: { id: sourceId },
          data: {
            lateFeeCreditedPaise: source.installment.lateFeeCreditedPaise + amountPaise,
            lateFeeWaived: true,
            lateFeeWaivedAt: new Date(),
            lateFeeWaivedReason: reason,
          },
        });
      }

      const touched = new Set<string>([...bySource.keys(), ...plan.map((entry) => entry.targetId)]);
      for (const installmentId of touched) {
        await refreshInstallment(installmentId, tx);
      }

      await tx.auditLog.create({
        data: {
          action: "fee.late_fee_waived",
          entityType: "Student",
          entityId: student.id,
          summary:
            `Collected late fee of ${formatPaise(studentCredited)} waived for ${student.studentCode} and credited ` +
            `against ${plan.length} unpaid installment(s) — institute-wide waiver`,
          reason,
          metadata: {
            script: "credit-collected-late-fees",
            creditedPaise: studentCredited,
            shortfallPaise: studentShortfall,
            credits: plan,
          },
        },
      });
    });
  }

  console.log("");
  console.log(
    `${creditedStudents} student(s) credited ${formatPaise(creditedTotal)} across ${creditRows} installment(s).`,
  );
  if (shortfalls.length > 0) {
    const total = shortfalls.reduce((sum, row) => sum + row.paise, 0);
    console.log(`${shortfalls.length} student(s) have ${formatPaise(total)} that cannot be credited — refund manually:`);
    for (const row of shortfalls) {
      console.log(`  ${row.code}  ${row.name}  ${formatPaise(row.paise)}`);
    }
  } else {
    console.log("Every collected late fee found somewhere to go — no manual refunds needed.");
  }
  if (dryRun) console.log("\ndry run — nothing was written.");

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
