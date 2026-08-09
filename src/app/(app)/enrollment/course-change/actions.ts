"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { recordAuditTx } from "@/lib/audit";
import { getConfig } from "@/lib/config";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { parsePlanRows, validateInstallmentPlan, type InstallmentDraft } from "@/lib/fees";
import { refreshInstallmentsBulk } from "@/lib/late-fees";
import { settleProvisionalAdmission } from "@/lib/enrollment";
import { loadCourseChangeContext, planCarriedCredit, snapshotOfStructure } from "@/lib/course-change";
import { formatDate } from "@/lib/dates";
import { formatPaise, percentOf } from "@/lib/money";
import { studentStatusLabel } from "@/lib/students";
import {
  fieldErrorsOf,
  formObject,
  optionalIntInput,
  optionalRupeeAmount,
  reasonInput,
  requiredText,
} from "@/lib/validation";
import type { Payment } from "@/generated/prisma/client";

const courseChangeSchema = z.object({
  studentId: requiredText("Student"),
  departmentId: requiredText("Department"),
  courseId: requiredText("Course"),
  batchId: requiredText("Batch"),
  semesterId: requiredText("Semester"),
  lockedTuitionRate: optionalRupeeAmount("Tuition rate"),
  scholarshipBasis: z.enum(["PERCENT", "AMOUNT"]).default("PERCENT"),
  scholarshipPercent: optionalIntInput("Scholarship", { min: 0, max: 100 }),
  scholarshipAmount: optionalRupeeAmount("Scholarship amount"),
  examFee: optionalRupeeAmount("Exam fee"),
  activityFee: optionalRupeeAmount("Activity fee"),
  /// The same JSON every installment editor posts: [{ dueDate, amount }].
  rows: requiredText("Installments"),
  reason: reasonInput,
});

/**
 * Move an enrolled student to a different course. Admin only.
 *
 * Three things happen together, and either all of them stick or none does:
 *
 *  1. **The old fee structure is scrapped.** Every fee assignment the student
 *     held is deleted, taking its installments — and any discount or reminder
 *     attached to them — with it. Nothing of the old charge is left to collect,
 *     to report on or to chase. What it looked like is written to the
 *     `CourseChange` row first, because after this nothing else remembers.
 *
 *  2. **The new course is billed.** A fee assignment is written for the semester
 *     the student joins, built exactly as approval builds the first one: the new
 *     batch's tuition rate, less any scholarship, plus that semester's exam and
 *     activity fees, spread over the plan the Admin laid out.
 *
 *  3. **The money follows them.** Not one receipt is cancelled, re-issued or
 *     deleted. Each payment keeps its number, date, mode and collector, and is
 *     re-applied to the new schedule oldest-first — settling the first
 *     installment, then the next, exactly as it would have if it had been
 *     collected against this plan all along.
 *
 * Two consequences worth stating plainly, because both are deliberate:
 *
 *  - Late fee already collected is credited as **principal** against the new
 *    fee. It was charged against due dates that no longer exist, so keeping it
 *    as a penalty would mean the family paid for the lateness of a schedule that
 *    has been thrown away.
 *  - Money the new fee cannot absorb — a move to a cheaper course — is left on
 *    the student as an unapplied credit rather than forced onto a settled
 *    installment, where it would vanish from the balance. It shows on the record
 *    as paid, and settles the next semester when the promotion run bills it.
 */
export async function changeCourseAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CHANGE_COURSE);
    const parsed = courseChangeSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { studentId, departmentId, courseId, batchId, semesterId, scholarshipBasis, reason } = parsed.data;
    const planned = parsePlanRows(parsed.data.rows);
    if ("error" in planned) return fail(planned.error, { rows: [planned.error] });

    const context = await loadCourseChangeContext(studentId);
    if (!context) return fail("Student not found.");
    const { student } = context;

    // Dropped-out and expelled students had their pending fees waived on the way
    // out; a passed student has finished. Moving any of them would bill a course
    // they are not on, so status is put right first.
    if (student.status !== "ACTIVE") {
      return fail(
        `${student.studentCode} is ${studentStatusLabel(student.status).toLowerCase()} — only an active student can be moved to another course. Change the status back first.`,
      );
    }

    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: {
        course: { include: { department: true } },
        semesters: { orderBy: { semesterNumber: "asc" } },
        _count: { select: { students: true } },
      },
    });
    if (!batch) return fail("Select a valid batch.", { batchId: ["Unknown batch."] });
    if (batch.courseId !== courseId || batch.course.departmentId !== departmentId) {
      return fail("The selected batch does not belong to that course and department.");
    }
    if (batch.id === student.batchId) {
      return fail(
        `${student.studentCode} is already in ${batch.name}. Choose the batch they are moving to.`,
        { batchId: ["This is the student's current batch."] },
      );
    }
    if (batch.status === "COMPLETED" || batch.status === "DISCONTINUED") {
      return fail("That batch is no longer accepting students.", { batchId: ["Batch is closed."] });
    }
    // Spec 5.3 — no waitlist; a full batch is closed even for a transfer.
    if (batch._count.students >= batch.totalSeats) {
      return fail("That batch is full. There is no waitlist.", { batchId: ["No seats available."] });
    }

    const semester = batch.semesters.find((candidate) => candidate.id === semesterId);
    if (!semester) {
      return fail("That semester does not belong to the new batch.", {
        semesterId: ["Choose a semester of the batch being joined."],
      });
    }

    const config = await getConfig();

    // The new course's fee, built exactly as enrollment builds it. A flat
    // concession can never exceed the tuition it is discounting, and the two
    // ways of quoting one are mutually exclusive.
    const lockedTuitionRatePaise = parsed.data.lockedTuitionRate;
    const asAmount = scholarshipBasis === "AMOUNT";
    const scholarshipPercent = asAmount ? 0 : (parsed.data.scholarshipPercent ?? 0);
    const scholarshipAmountPaise = asAmount
      ? Math.min(parsed.data.scholarshipAmount, lockedTuitionRatePaise)
      : percentOf(lockedTuitionRatePaise, scholarshipPercent);
    const tuitionComponentPaise = lockedTuitionRatePaise - scholarshipAmountPaise;
    const totalPayablePaise = tuitionComponentPaise + parsed.data.examFee + parsed.data.activityFee;

    if (totalPayablePaise <= 0) {
      return fail(
        "There is nothing to charge for the new course — give a tuition rate, an exam fee or an activity fee. Scrapping the old fee and assigning nothing in its place would leave the student with a credit and no charge against it.",
      );
    }

    const plan: InstallmentDraft[] = planned.rows.map((row, index) => ({
      seqNo: index + 1,
      dueDate: row.dueDate,
      amountPaise: row.amountPaise,
    }));
    const problem = validateInstallmentPlan({
      rows: plan,
      totalPayablePaise,
      completionDate: batch.completionDate,
      minCount: config.installmentMin,
      maxCount: config.installmentMax,
    });
    if (problem) return fail(problem, { rows: [problem] });

    // Read outside the transaction: policy tables and the receipt numbering the
    // split lines below need, neither of which changes while this runs.
    const receiptNos = [...new Set(context.carriedPayments.map((payment) => payment.receiptNo))];
    const [slabs, siblingLines] = await Promise.all([
      prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
      receiptNos.length > 0
        ? prisma.payment.findMany({
            where: { receiptNo: { in: receiptNos } },
            select: { receiptNo: true, receiptSeq: true },
          })
        : Promise.resolve([]),
    ]);

    /** Next free line number on each receipt, so a split never collides. */
    const nextReceiptSeq = new Map<string, number>();
    for (const line of siblingLines) {
      nextReceiptSeq.set(line.receiptNo, Math.max(nextReceiptSeq.get(line.receiptNo) ?? 0, line.receiptSeq + 1));
    }

    const snapshot = snapshotOfStructure(context);
    const scrappedAssignmentIds = student.feeAssignments.map((assignment) => assignment.id);
    const scrappedInstallmentIds = student.feeAssignments.flatMap((assignment) =>
      assignment.installments.map((installment) => installment.id),
    );
    const paymentsById = new Map(context.carriedPayments.map((payment) => [payment.id, payment]));
    const from = {
      courseId: student.courseId,
      courseName: student.course.name,
      batchId: student.batchId,
      batchCode: student.batch.code,
      semesterNumber: student.currentSemester?.semesterNumber ?? null,
    };
    const now = new Date();

    const result = await prisma.$transaction(
      async (tx) => {
        /* --- 1. the new course's fee ------------------------------------- */

        const assignment = await tx.feeAssignment.create({
          data: {
            studentId,
            semesterId: semester.id,
            academicYearId: semester.academicYearId,
            yearNumber: semester.yearNumber,
            lockedTuitionRatePaise,
            tuitionComponentPaise,
            scholarshipPercent,
            scholarshipAmountPaise,
            examFeePaise: parsed.data.examFee,
            activityFeePaise: parsed.data.activityFee,
            totalPayablePaise,
            note: `Assigned on transfer from ${from.courseName} (${from.batchCode})`,
            createdById: actor.id,
          },
        });

        const written = await tx.installment.createManyAndReturn({
          data: plan.map((item) => ({ ...item, feeAssignmentId: assignment.id })),
        });
        const ordered = [...written].sort((a, b) => a.seqNo - b.seqNo);

        /* --- 2. carry the money onto it ---------------------------------- */

        const allocation = planCarriedCredit({
          payments: context.carriedPayments,
          installments: ordered.map((installment) => ({
            id: installment.id,
            amountPaise: installment.amountPaise,
          })),
        });

        // The row itself moves. Its late-fee split is cleared: the fee it paid
        // was assessed against a due date that is about to be deleted, so the
        // whole amount counts towards the new course's principal.
        for (const move of allocation.moves) {
          await tx.payment.update({
            where: { id: move.paymentId },
            data: {
              installmentId: move.installmentId,
              amountPaise: move.amountPaise,
              lateFeePortionPaise: 0,
            },
          });
        }

        // A payment large enough to reach past one installment becomes several
        // lines on its own receipt — the same shape a collection already takes
        // when FIFO spreads it across installments.
        const extraLines = allocation.splits.flatMap((split) => {
          const source = paymentsById.get(split.paymentId);
          if (!source) return [];
          const receiptSeq = nextReceiptSeq.get(source.receiptNo) ?? source.receiptSeq + 1;
          nextReceiptSeq.set(source.receiptNo, receiptSeq + 1);
          return [
            {
              receiptNo: source.receiptNo,
              receiptSeq,
              kind: source.kind,
              status: source.status,
              applicationId: source.applicationId,
              studentId: source.studentId,
              installmentId: split.installmentId,
              amountPaise: split.amountPaise,
              lateFeePortionPaise: 0,
              paymentDate: source.paymentDate,
              mode: source.mode,
              referenceNo: source.referenceNo,
              remarks: source.remarks,
              collectedById: source.collectedById,
            },
          ];
        });
        if (extraLines.length > 0) await tx.payment.createMany({ data: extraLines });

        // Status and late fee follow from what now sits on each installment, so
        // the new rows are settled from the copies already in hand rather than a
        // read apiece. A back-dated plan therefore carries its late fee from the
        // moment it is written, without waiting for the nightly job.
        const carriedByInstallment = new Map<string, { amountPaise: number }[]>();
        for (const line of [...allocation.moves, ...allocation.splits]) {
          if (!line.installmentId) continue;
          carriedByInstallment.set(line.installmentId, [
            ...(carriedByInstallment.get(line.installmentId) ?? []),
            { amountPaise: line.amountPaise },
          ]);
        }
        await refreshInstallmentsBulk(
          ordered.map((installment) => ({
            installment: {
              ...installment,
              // Only the three fields `balanceOf` reads are needed to settle a
              // brand-new row, so the allocation is handed over as-is.
              payments: (carriedByInstallment.get(installment.id) ?? []).map((line) => ({
                status: "ACTIVE" as const,
                amountPaise: line.amountPaise,
                lateFeePortionPaise: 0,
              })) as unknown as Payment[],
            },
            asOf: now,
            // Late fee never accrues while an admission is provisional.
            lateFeeExempt: student.application.isProvisional,
            discountPaise: 0,
          })),
          slabs,
          config,
          tx,
        );

        /* --- 3. scrap the old structure ---------------------------------- */

        // Cancelled receipts carry no money, so they are not re-applied — but
        // they still point at installments that are about to go. Cutting the
        // link explicitly says so, rather than leaving it to the foreign key.
        if (scrappedInstallmentIds.length > 0) {
          await tx.payment.updateMany({
            where: { studentId, status: "CANCELLED", installmentId: { in: scrappedInstallmentIds } },
            data: { installmentId: null },
          });
        }
        if (scrappedAssignmentIds.length > 0) {
          await tx.feeAssignment.deleteMany({ where: { id: { in: scrappedAssignmentIds } } });
        }

        /* --- 4. move the student ----------------------------------------- */

        await tx.student.update({
          where: { id: studentId },
          data: { departmentId, courseId, batchId, currentSemesterId: semester.id },
        });

        // The application is the record the admission form and the welcome kit
        // print from, so it moves too — a student whose record says one course
        // and whose printed form says another is worse than either alone. What
        // the admission was *decided* on is untouched: the decision, its reason,
        // the reviewer and the dates all stand, and this change has its own
        // record beside them.
        await tx.application.update({
          where: { id: student.application.id },
          data: {
            departmentId,
            courseId,
            batchId,
            academicYearId: semester.academicYearId ?? undefined,
            approvedScholarshipPercent: scholarshipPercent,
            approvedScholarshipPaise: asAmount ? scholarshipAmountPaise : null,
          },
        });
        await tx.applicationInstallment.deleteMany({ where: { applicationId: student.application.id } });
        await tx.applicationInstallment.createMany({
          data: plan.map((item) => ({
            applicationId: student.application.id,
            seqNo: item.seqNo,
            dueDate: item.dueDate,
            amountPaise: item.amountPaise,
          })),
        });

        /* --- 5. the record of what happened ------------------------------ */

        const change = await tx.courseChange.create({
          data: {
            studentId,
            changedById: actor.id,
            reason,
            fromCourseId: from.courseId,
            fromBatchId: from.batchId,
            fromSemesterNumber: from.semesterNumber,
            toCourseId: courseId,
            toBatchId: batchId,
            toSemesterNumber: semester.semesterNumber,
            scrappedAssignmentCount: context.scrapped.assignmentCount,
            scrappedInstallmentCount: context.scrapped.installmentCount,
            scrappedTotalPayablePaise: context.scrapped.assignedPaise,
            scrappedDiscountPaise: context.scrapped.activeDiscountPaise,
            scrappedSnapshot: snapshot as never,
            carriedPaidPaise: allocation.carriedPaise,
            releasedLateFeePaise: context.carriedLateFeePaise,
            unallocatedPaise: allocation.unallocatedPaise,
            newTotalPayablePaise: totalPayablePaise,
            newInstallmentCount: plan.length,
          },
        });

        await recordAuditTx(tx, {
          userId: actor.id,
          action: "student.course_changed",
          entityType: "Student",
          entityId: studentId,
          summary:
            `${student.studentCode} moved from ${from.courseName} (${from.batchCode}) to ${batch.course.name} ` +
            `(${batch.code}), semester ${semester.semesterNumber} — ` +
            `${formatPaise(context.scrapped.assignedPaise)} of assigned fee scrapped, ` +
            `${formatPaise(totalPayablePaise)} assigned instead, ` +
            `${formatPaise(allocation.allocatedPaise)} of collected fee carried across`,
          reason,
          metadata: {
            courseChangeId: change.id,
            from,
            to: {
              courseId,
              courseName: batch.course.name,
              batchId,
              batchCode: batch.code,
              semesterNumber: semester.semesterNumber,
            },
            scrapped: context.scrapped,
            newFee: {
              lockedTuitionRatePaise,
              scholarshipPercent,
              scholarshipAmountPaise,
              examFeePaise: parsed.data.examFee,
              activityFeePaise: parsed.data.activityFee,
              totalPayablePaise,
              installmentCount: plan.length,
              firstDueDate: plan[0].dueDate,
              lastDueDate: plan[plan.length - 1].dueDate,
            },
            money: {
              carriedPaise: allocation.carriedPaise,
              allocatedPaise: allocation.allocatedPaise,
              unallocatedPaise: allocation.unallocatedPaise,
              releasedLateFeePaise: context.carriedLateFeePaise,
              receiptsTouched: receiptNos.length,
              linesAdded: extraLines.length,
            },
          },
        });

        return { allocation, splitCount: extraLines.length };
      },
      // A receipt apiece has to be re-applied and every statement is a round
      // trip to a hosted database, so a student with a long payment history
      // needs far more room than the default assumes.
      { timeout: 60_000 },
    );

    // The registration money now sits inside the new installment 1, so settling
    // it can confirm an admission that was still provisional.
    const { cleared } = await settleProvisionalAdmission(student.application.id, actor.id);

    revalidatePath("/students");
    revalidatePath(`/students/${studentId}`);
    revalidatePath("/enrollment");
    revalidatePath(`/enrollment/${student.application.id}`);
    revalidatePath("/enrollment/course-change");
    revalidatePath("/fees/collect");
    revalidatePath("/reports/ledger");
    revalidatePath("/reports");

    const { allocation } = result;
    return ok(
      undefined,
      `${student.studentCode} moved to ${batch.course.name} (${batch.code}), semester ${semester.semesterNumber}. ` +
        `${formatPaise(totalPayablePaise)} assigned over ${plan.length} installment(s), first due ${formatDate(
          plan[0].dueDate,
        )}. ` +
        (allocation.carriedPaise > 0
          ? `${formatPaise(allocation.allocatedPaise)} already collected has been applied to the new schedule` +
            (allocation.unallocatedPaise > 0
              ? `, and ${formatPaise(
                  allocation.unallocatedPaise,
                )} more than the new fee is held as a credit against what is billed next.`
              : ".")
          : "No fee had been collected, so there was nothing to carry across.") +
        (cleared ? " The registration fee is now cleared, so the provisional admission has been confirmed." : ""),
    );
  });
}
