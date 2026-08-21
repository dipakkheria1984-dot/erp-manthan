"use server";

import { revalidatePath } from "next/cache";
import { notifyCampusMany } from "@/lib/campus/publisher";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { recordAuditTx } from "@/lib/audit";
import { getConfig } from "@/lib/config";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { buildInstallmentPlan } from "@/lib/fees";
import { percentOf } from "@/lib/money";
import { dateInput, fieldErrorsOf, formObject, intInput, optionalText, requiredText } from "@/lib/validation";

const promotionSchema = z.object({
  batchId: requiredText("Batch"),
  fromSemesterId: requiredText("Current semester"),
  installmentCount: intInput("Installments", { min: 1, max: 60 }),
  firstDueDate: dateInput("First installment due date"),
  notes: optionalText,
});

/**
 * Bulk-promote a batch's current cohort to the next semester (spec 6).
 *
 * - Pending dues never block promotion; the outstanding balance stays attached
 *   to its original semester's installments and simply carries forward.
 * - A failing student is promoted anyway with the informational backlog flag —
 *   `backlog:<studentId>` in the form marks them.
 * - Students can be excluded individually via `exclude:<studentId>`; an
 *   exclusion reason is recorded in the run's audit trail.
 * - Fee for the new semester: exam and activity fees at their current value,
 *   and tuition only when the promotion crosses into a new year of the course
 *   (spec 6.4), charged at the student's locked rate with no scholarship.
 */
export async function runPromotionAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.PROMOTION_RUN);
    const parsed = promotionSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { batchId, fromSemesterId, installmentCount, firstDueDate, notes } = parsed.data;
    const config = await getConfig();
    if (installmentCount < config.installmentMin || installmentCount > config.installmentMax) {
      return fail(`Installments must be between ${config.installmentMin} and ${config.installmentMax}.`, {
        installmentCount: [`Allowed range is ${config.installmentMin}–${config.installmentMax}.`],
      });
    }

    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { course: true, semesters: { orderBy: { semesterNumber: "asc" } } },
    });
    if (!batch) return fail("Batch not found.");

    const fromSemester = batch.semesters.find((s) => s.id === fromSemesterId);
    if (!fromSemester) return fail("That semester does not belong to this batch.");

    // Sequential enforcement (spec 5.4) — promotion always steps to the next one.
    const toSemester = batch.semesters.find((s) => s.semesterNumber === fromSemester.semesterNumber + 1);
    if (!toSemester) {
      return fail("This is the final semester of the course — there is nothing to promote into.");
    }
    if (firstDueDate > batch.completionDate) {
      return fail("The first installment falls after the batch completion date.", {
        firstDueDate: ["Must be on or before the batch completion date."],
      });
    }

    // Only active students in the current semester are candidates (spec 4.5).
    const candidates = await prisma.student.findMany({
      where: { batchId, currentSemesterId: fromSemesterId, status: "ACTIVE" },
      orderBy: { studentCode: "asc" },
    });
    if (candidates.length === 0) return fail("No active students are currently in that semester.");

    const excluded = new Set<string>();
    const exclusionReasons = new Map<string, string>();
    const backlogged = new Set<string>();
    for (const [key, value] of formData.entries()) {
      if (typeof value !== "string") continue;
      if (key.startsWith("exclude:") && value === "on") excluded.add(key.slice("exclude:".length));
      if (key.startsWith("backlog:") && value === "on") backlogged.add(key.slice("backlog:".length));
      if (key.startsWith("reason:") && value.trim()) exclusionReasons.set(key.slice("reason:".length), value.trim());
    }

    const included = candidates.filter((student) => !excluded.has(student.id));
    if (included.length === 0) return fail("Every student was excluded — nothing to promote.");

    // Tuition re-applies only when the new semester belongs to a later year.
    const crossesYear = toSemester.yearNumber > fromSemester.yearNumber;

    /*
     * The cohort is promoted in a fixed number of statements rather than a
     * handful per student. Billing them one at a time meant a rate lookup, an
     * upsert, a count, a plan write and a status update each — seven round trips
     * a head, so a batch of any size spent the transaction's budget before it
     * finished and the whole promotion rolled back.
     */
    const [feeHistory, alreadyAssigned] = await Promise.all([
      prisma.batchFeeHistory.findMany({ where: { batchId }, orderBy: { effectiveFrom: "asc" } }),
      prisma.feeAssignment.findMany({
        where: { semesterId: toSemester.id, studentId: { in: included.map((s) => s.id) } },
        select: { studentId: true },
      }),
    ]);

    /** `tuitionRateAt` in memory — the batch's history is the same for everyone. */
    const rateAt = (asOf: Date): number => {
      const applicable = feeHistory.filter((row) => row.effectiveFrom <= asOf).at(-1);
      // Enrolled before the first revision was recorded — fall back to the
      // earliest known rate rather than charging nothing.
      return (applicable ?? feeHistory[0])?.tuitionFeePaise ?? 0;
    };
    const assignedAlready = new Set(alreadyAssigned.map((row) => row.studentId));

    await prisma.$transaction(
      async (tx) => {
        const run = await tx.promotionRun.create({
          data: {
            batchId,
            fromSemesterId,
            toSemesterId: toSemester.id,
            runById: actor.id,
            includedCount: included.length,
            excludedCount: excluded.size,
            notes,
          },
        });

        await tx.promotionRunStudent.createMany({
          data: candidates.map((student) => {
            const isIncluded = !excluded.has(student.id);
            return {
              promotionRunId: run.id,
              studentId: student.id,
              included: isIncluded,
              exclusionReason: isIncluded ? null : (exclusionReasons.get(student.id) ?? "No reason given"),
              backlogFlagged: backlogged.has(student.id),
            };
          }),
        });

        // Year 2+ pays Year 1's original fee — the locked rate, no scholarship.
        const billing = included.map((student) => {
          const lockedRate = crossesYear ? rateAt(student.enrollmentDate) : 0;
          const tuitionComponent = crossesYear ? lockedRate - percentOf(lockedRate, 0) : 0;
          return {
            student,
            lockedRate,
            tuitionComponent,
            total: tuitionComponent + toSemester.examFeePaise + toSemester.activityFeePaise,
          };
        });

        // A student already assigned this semester keeps what they have — a
        // re-run must never bill the same semester twice.
        const fresh = billing.filter((entry) => !assignedAlready.has(entry.student.id));
        const created =
          fresh.length === 0
            ? []
            : await tx.feeAssignment.createManyAndReturn({
                select: { id: true, studentId: true },
                data: fresh.map((entry) => ({
                  studentId: entry.student.id,
                  semesterId: toSemester.id,
                  academicYearId: toSemester.academicYearId,
                  yearNumber: toSemester.yearNumber,
                  lockedTuitionRatePaise: entry.lockedRate,
                  tuitionComponentPaise: entry.tuitionComponent,
                  scholarshipPercent: 0,
                  scholarshipAmountPaise: 0,
                  examFeePaise: toSemester.examFeePaise,
                  activityFeePaise: toSemester.activityFeePaise,
                  totalPayablePaise: entry.total,
                  createdById: actor.id,
                })),
              });
        const assignmentByStudent = new Map(created.map((row) => [row.studentId, row.id]));

        const installments = fresh.flatMap((entry) => {
          const feeAssignmentId = assignmentByStudent.get(entry.student.id);
          if (!feeAssignmentId || entry.total <= 0) return [];
          return buildInstallmentPlan({
            totalPayablePaise: entry.total,
            count: installmentCount,
            firstDueDate,
            completionDate: batch.completionDate,
          }).map((item) => ({ ...item, feeAssignmentId }));
        });
        if (installments.length > 0) await tx.installment.createMany({ data: installments });

        // Everyone included moves; only the flagged ones pick up the backlog.
        const flagged = included.filter((student) => backlogged.has(student.id)).map((s) => s.id);
        const plain = included.filter((student) => !backlogged.has(student.id)).map((s) => s.id);
        if (plain.length > 0) {
          await tx.student.updateMany({
            where: { id: { in: plain } },
            data: { currentSemesterId: toSemester.id },
          });
        }
        if (flagged.length > 0) {
          await tx.student.updateMany({
            where: { id: { in: flagged } },
            data: { currentSemesterId: toSemester.id, hasBacklog: true },
          });
        }

        await recordAuditTx(tx, {
          userId: actor.id,
          action: "promotion.run",
          entityType: "Batch",
          entityId: batchId,
          summary:
            `Batch ${batch.code} promoted from semester ${fromSemester.semesterNumber} to ${toSemester.semesterNumber} — ` +
            `${included.length} included, ${excluded.size} excluded`,
          reason: notes ?? null,
          metadata: {
            promotionRunId: run.id,
            crossesYear,
            included: included.map((s) => s.studentCode),
            excluded: [...excluded].map((id) => ({
              studentCode: candidates.find((s) => s.id === id)?.studentCode,
              reason: exclusionReasons.get(id) ?? "No reason given",
            })),
            backlogFlagged: [...backlogged].map((id) => candidates.find((s) => s.id === id)?.studentCode),
            installmentCount,
          },
        });
      },
      // Every statement is a round trip to a hosted database, and a cohort is
      // promoted as one unit — give it more room than the default assumes.
      { timeout: 60_000 },
    );

    // Queued after the transaction commits, so nothing is published for a
    // promotion that rolled back. One row per student per topic, coalesced.
    await notifyCampusMany(included.map((student) => student.id), "ALL", "promotion.run");

    revalidatePath("/promotion");
    revalidatePath("/students");
    return ok(
      undefined,
      `Promoted ${included.length} student(s) to semester ${toSemester.semesterNumber}${
        excluded.size > 0 ? `, excluding ${excluded.size}` : ""
      }. ${crossesYear ? "Tuition was re-applied for the new academic year." : "Tuition was not re-applied — same academic year."}`,
    );
  });
}
