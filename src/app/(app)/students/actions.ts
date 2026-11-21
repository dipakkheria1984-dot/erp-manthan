"use server";

import { revalidatePath } from "next/cache";
import { notifyCampus } from "@/lib/campus/publisher";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { assertPermission } from "@/lib/auth";
import { recordAuditTx } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import {
  balanceOf,
  chargeableDaysOverdue,
  computeLateFee,
  refreshInstallment,
  refreshInstallmentsBulk,
} from "@/lib/late-fees";
import { parsePlanRows, validateInstallmentPlan, type InstallmentDraft } from "@/lib/fees";
import { formatDate, startOfDay } from "@/lib/dates";
import { formatPaise, percentOf, rupeesToPaise } from "@/lib/money";
import {
  checkboxInput,
  dateInput,
  fieldErrorsOf,
  formObject,
  optionalDateInput,
  optionalIntInput,
  optionalRupeeAmount,
  optionalText,
  reasonInput,
  requiredText,
  rupeeAmount,
} from "@/lib/validation";
import type { StudentStatus } from "@/generated/prisma/client";

const statusSchema = z.object({
  studentId: requiredText("Student"),
  status: z.enum(["ACTIVE", "DROPPED_OUT", "EXPELLED", "PASSED"]),
  reason: optionalText,
});

/**
 * Change a student's status (spec 4). Admin only.
 *
 * A reason is mandatory for Dropped-out, Expelled and reinstatement, and not
 * required for Active → Passed. Moving to Dropped-out or Expelled auto-waives
 * every pending/partially-paid installment together with its accrued late fee;
 * money already received is never auto-refunded.
 *
 * Reinstatement does **not** restore waived installments — Admin reviews them
 * case by case (see `unwaiveInstallmentAction`).
 */
export async function changeStudentStatusAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.STUDENT_STATUS_CHANGE);
    const parsed = statusSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { studentId, status, reason } = parsed.data;
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) return fail("Student not found.");
    if (student.status === status) return fail(`This student is already ${status.replaceAll("_", "-").toLowerCase()}.`);

    const exiting = status === "DROPPED_OUT" || status === "EXPELLED";
    const reinstating =
      status === "ACTIVE" && (student.status === "DROPPED_OUT" || student.status === "EXPELLED");

    if (exiting || reinstating) {
      const parsedReason = reasonInput.safeParse(reason ?? "");
      if (!parsedReason.success) {
        return fail("A reason is required for this status change.", {
          reason: [parsedReason.error.issues[0].message],
        });
      }
    }

    let waivedCount = 0;
    let waivedAmount = 0;

    await prisma.$transaction(async (tx) => {
      if (exiting) {
        const pending = await tx.installment.findMany({
          where: {
            feeAssignment: { studentId },
            status: { in: ["PENDING", "PARTIALLY_PAID"] },
          },
          include: { payments: { where: { status: "ACTIVE" } } },
        });

        for (const installment of pending) {
          const paid = installment.payments.reduce((sum, p) => sum + p.amountPaise, 0);
          waivedAmount += Math.max(0, installment.amountPaise - paid) + installment.lateFeePaise;
          waivedCount += 1;
        }

        // Every row is waived on the same terms, so one statement does it —
        // a student part-way through a long course can carry dozens, and a
        // round trip each is what put this over the transaction's budget.
        if (pending.length > 0) {
          await tx.installment.updateMany({
            where: { id: { in: pending.map((installment) => installment.id) } },
            data: {
              status: "WAIVED",
              waivedAt: new Date(),
              waivedById: actor.id,
              waivedReason: `Auto-waived on status change to ${status.replaceAll("_", "-").toLowerCase()}`,
              waivedContext: "STATUS_CHANGE",
              // Accrued late fee is cancelled along with the principal.
              lateFeePaise: 0,
            },
          });
        }
      }

      await tx.student.update({
        where: { id: studentId },
        data: { status: status as StudentStatus, statusReason: reason ?? null },
      });

      await tx.studentStatusHistory.create({
        data: {
          studentId,
          fromStatus: student.status,
          toStatus: status as StudentStatus,
          reason: reason ?? null,
          changedById: actor.id,
        },
      });

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "student.status_changed",
        entityType: "Student",
        entityId: studentId,
        summary:
          `${student.studentCode} moved from ${student.status.replaceAll("_", "-").toLowerCase()} to ` +
          `${status.replaceAll("_", "-").toLowerCase()}` +
          (waivedCount > 0 ? ` — ${waivedCount} installment(s) waived (${formatPaise(waivedAmount)})` : ""),
        reason: reason ?? null,
        metadata: { from: student.status, to: status, waivedCount, waivedAmountPaise: waivedAmount },
      });
    });

    revalidatePath(`/students/${studentId}`);
    await notifyCampus(studentId, "ALL", "student.status");
    revalidatePath("/students");

    if (exiting) {
      return ok(
        undefined,
        `Status updated. ${waivedCount} pending installment(s) totalling ${formatPaise(waivedAmount)} were waived. Amounts already paid are not refunded automatically.`,
      );
    }
    if (reinstating) {
      return ok(
        undefined,
        "Student reinstated. Previously waived installments were not restored — review them below and un-waive the ones that should stand.",
      );
    }
    return ok(undefined, "Status updated.");
  });
}

/* -------------------------------------------------------------------------- */
/* Profile / admission details                                                 */
/* -------------------------------------------------------------------------- */

const profileSchema = z.object({
  studentId: requiredText("Student"),
  fullName: requiredText("Full name", 2),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]),
  dob: optionalDateInput,
  bloodGroup: optionalText,
  addressLine1: optionalText,
  addressLine2: optionalText,
  city: optionalText,
  state: optionalText,
  pincode: optionalText,
  phone: optionalText,
  email: optionalText,
  nationalId: optionalText,
  previousEnrollmentNo: optionalText,
  previousInstitution: optionalText,
  previousQualification: optionalText,
  previousMarks: optionalText,
  hasTransferCertificate: checkboxInput,
});

/** The fields the student record and the application both carry. */
const SHARED_FIELDS = [
  "fullName",
  "dob",
  "gender",
  "bloodGroup",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "pincode",
  "phone",
  "email",
  "nationalId",
] as const;

/**
 * Correct an enrolled student's admission details.
 *
 * The application is locked once it is approved — that lock is what stops a
 * later edit quietly rewriting the terms an admission was granted on. It also
 * left no way to fix a misspelt name or a changed phone number, which is what
 * this is for: the same admission-form fields, edited from the student record.
 *
 * Both records are written. The student record is what the app reads day to
 * day; the application is what the admission form and the welcome kit print
 * from, and a correction that showed up in only one of them would be worse than
 * no correction at all. What the admission was *decided* on — batch, fee,
 * scholarship, dates, documents — is untouched here.
 *
 * A blank field is stored as blank: `undefined` would leave the old value in
 * place, so nothing could ever be cleared.
 */
export async function updateStudentProfileAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    // Same authority as editing the admission form before approval: this is
    // that form, reopened. No new permission, so every role that could enter
    // these details can correct them.
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CREATE);
    const parsed = profileSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { studentId, ...data } = parsed.data;
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: { application: true },
    });
    if (!student) return fail("Student not found.");

    const shared = {
      fullName: data.fullName,
      gender: data.gender,
      dob: data.dob ?? null,
      bloodGroup: data.bloodGroup ?? null,
      addressLine1: data.addressLine1 ?? null,
      addressLine2: data.addressLine2 ?? null,
      city: data.city ?? null,
      state: data.state ?? null,
      pincode: data.pincode ?? null,
      phone: data.phone ?? null,
      email: data.email ?? null,
      nationalId: data.nationalId ?? null,
    };

    // Named in the audit trail so a later reader can see what was corrected
    // without diffing two records by eye.
    const changed = SHARED_FIELDS.filter((field) => {
      const before = student[field];
      const after = shared[field];
      if (before instanceof Date || after instanceof Date) {
        return (before as Date | null)?.getTime() !== (after as Date | null)?.getTime();
      }
      return (before ?? null) !== after;
    });

    await prisma.$transaction(async (tx) => {
      await tx.student.update({ where: { id: studentId }, data: shared });
      await tx.application.update({
        where: { id: student.applicationId },
        data: {
          ...shared,
          previousEnrollmentNo: data.previousEnrollmentNo ?? null,
          previousInstitution: data.previousInstitution ?? null,
          previousQualification: data.previousQualification ?? null,
          previousMarks: data.previousMarks ?? null,
          hasTransferCertificate: data.hasTransferCertificate,
        },
      });

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "student.profile_updated",
        entityType: "Student",
        entityId: studentId,
        summary:
          changed.length > 0
            ? `Profile updated for ${student.studentCode} — ${changed.join(", ")} changed`
            : `Profile saved for ${student.studentCode} — previous education details only`,
        metadata: { applicationId: student.applicationId, changedFields: changed },
      });
    });

    revalidatePath(`/students/${studentId}`);
    await notifyCampus(studentId, "STUDENT", "student.profile");
    revalidatePath("/students");
    revalidatePath(`/enrollment/${student.applicationId}`);
    revalidatePath(`/enrollment/${student.applicationId}/edit`);
    return ok(
      undefined,
      "Profile updated. The admission form and welcome kit will print the corrected details from now on.",
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Extra charges raised after enrollment                                       */
/* -------------------------------------------------------------------------- */

const extraChargeSchema = z.object({
  feeAssignmentId: requiredText("Semester"),
  kind: z.enum(["ACTIVITY", "EVENT", "PENALTY", "OTHER"]),
  label: requiredText("Description", 3).max(120, "Keep the description under 120 characters."),
  amount: rupeeAmount("Amount", { min: 1 }),
  dueDate: dateInput("Due date"),
  note: optionalText,
});

/**
 * Bill a student for something that was never part of the admission fee — an
 * extra activity, an event, a fine.
 *
 * It is raised as an installment on the semester's fee assignment, which is the
 * whole point: collection, receipts, the ledger, the Fee Due report, reminders
 * and the late fee slabs all work on installments, so an extra charge behaves
 * like any other money owed without a second code path for it. What marks it
 * out is `extraChargeKind` and its label, which is what the family sees.
 *
 * The assignment's total grows by the charge, so what is assigned still equals
 * what the installments come to. It sits after the agreed plan and outside its
 * rules — the plan is a schedule for one fee, while this is a new charge, and
 * holding it to the plan's installment count would mean a fine could not be
 * raised on a student whose plan already fills the allowance.
 *
 * Cancelling one is the existing waiver: it writes the charge off with a reason
 * and keeps it on record.
 */
export async function addExtraChargeAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_ASSIGN);
    const parsed = extraChargeSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { feeAssignmentId, kind, label, amount, dueDate, note } = parsed.data;

    const assignment = await prisma.feeAssignment.findUnique({
      where: { id: feeAssignmentId },
      include: {
        semester: { select: { semesterNumber: true } },
        student: { select: { id: true, studentCode: true, status: true, batch: { select: { completionDate: true } } } },
        installments: { select: { seqNo: true } },
      },
    });
    if (!assignment) return fail("Choose the semester this charge belongs to.", { feeAssignmentId: ["Unknown."] });

    const student = assignment.student;
    if (student.status === "DROPPED_OUT" || student.status === "EXPELLED") {
      return fail(
        `${student.studentCode} is ${student.status.replaceAll("_", "-").toLowerCase()} — reinstate the student before billing anything further.`,
      );
    }

    const nextSeqNo = assignment.installments.reduce((max, installment) => Math.max(max, installment.seqNo), 0) + 1;

    await prisma.$transaction(async (tx) => {
      const created = await tx.installment.create({
        data: {
          feeAssignmentId,
          seqNo: nextSeqNo,
          dueDate,
          amountPaise: amount,
          extraChargeKind: kind,
          label,
          raisedById: actor.id,
          raisedReason: note ?? null,
        },
      });

      await tx.feeAssignment.update({
        where: { id: feeAssignmentId },
        data: { totalPayablePaise: { increment: amount } },
      });

      // Sets the status and assesses a late fee if it is already overdue.
      await refreshInstallment(created.id, tx);

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.extra_charge_raised",
        entityType: "Installment",
        entityId: created.id,
        summary:
          `${formatPaise(amount)} ${kind.toLowerCase()} charge "${label}" raised for ${student.studentCode} ` +
          `on semester ${assignment.semester.semesterNumber}`,
        reason: note ?? undefined,
        metadata: { amountPaise: amount, kind, label, dueDate, feeAssignmentId },
      });
    });

    revalidatePath(`/students/${student.id}`);
    await notifyCampus(student.id, "FINANCE", "fee.extra_charge");
    revalidatePath(`/students/${student.id}/fees/${feeAssignmentId}`);
    revalidatePath("/fees/collect");
    revalidatePath("/reports/ledger");
    return ok(
      undefined,
      `${formatPaise(amount)} charged — “${label}”, due ${formatDate(dueDate)}. It is collectible now, like any other installment.`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Assigning a semester's fee                                                  */
/* -------------------------------------------------------------------------- */

const assignFeeSchema = z.object({
  studentId: requiredText("Student"),
  semesterId: requiredText("Semester"),
  lockedTuitionRate: optionalRupeeAmount("Tuition rate"),
  scholarshipBasis: z.enum(["PERCENT", "AMOUNT"]).default("PERCENT"),
  scholarshipPercent: optionalIntInput("Scholarship", { min: 0, max: 100 }),
  scholarshipAmount: optionalRupeeAmount("Scholarship amount"),
  examFee: optionalRupeeAmount("Exam fee"),
  activityFee: optionalRupeeAmount("Activity fee"),
  /// Same JSON the edit screen posts: [{ dueDate: "yyyy-MM-dd", amount: "1234.00" }].
  rows: requiredText("Installments"),
  note: optionalText,
});

/**
 * Assign a semester's fee to a student who has none for it.
 *
 * Every other route into a fee assignment is tied to a moment in a student's
 * progress: approval bills the first semester, a promotion run bills the one it
 * moves a cohort into. A student who arrived by bulk import (spec 1.8) went
 * through neither. The importer records an opening balance when the file
 * carries one, but a migrated student with nothing outstanding lands mid-course
 * with no charge against them at all — nothing in the ledger, nothing in Fee
 * Due, nothing to collect against — and no way to put that right from the
 * record. This is that way.
 *
 * The installments arrive as a plan the user has laid out row by row, held to
 * the same rules the enrollment step and the edit screen enforce: they must add
 * up to the fee, run in date order, and finish on or before the batch
 * completion date. What it produces is indistinguishable from a fee assigned by
 * approval or a promotion run. Editing it afterwards is the existing "Edit
 * assigned fee" screen; this only fills a gap, and refuses a semester that
 * already has one.
 *
 * Back-dated due dates are expected here — a migrated student is usually
 * part-way through the semester being billed — so installments already past
 * their date carry their late fee from the moment they are written rather than
 * waiting for the nightly job to notice them. That fee is worked out in memory
 * from one read of the slabs: calling `refreshInstallment` per row was several
 * round trips each, which is what put this over the transaction's budget.
 */
export async function assignSemesterFeeAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_ASSIGN);
    const parsed = assignFeeSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { studentId, semesterId, scholarshipBasis, note } = parsed.data;
    const planned = parsePlanRows(parsed.data.rows);
    if ("error" in planned) return fail(planned.error, { rows: [planned.error] });

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        studentCode: true,
        status: true,
        batchId: true,
        batch: { select: { code: true, completionDate: true } },
        // Late fee never accrues while an admission is provisional (spec 3.2).
        application: { select: { isProvisional: true } },
      },
    });
    if (!student) return fail("Student not found.");
    if (student.status === "DROPPED_OUT" || student.status === "EXPELLED") {
      return fail(
        `${student.studentCode} is ${student.status.replaceAll("_", "-").toLowerCase()} — reinstate the student before billing anything further.`,
      );
    }

    const semester = await prisma.semester.findUnique({ where: { id: semesterId } });
    if (!semester || semester.batchId !== student.batchId) {
      return fail("That semester does not belong to this student's batch.", {
        semesterId: ["Choose a semester of the student's own batch."],
      });
    }

    // One assignment per student per semester, so this can only ever fill a gap.
    // Changing a fee already assigned is the edit screen, which protects what
    // has been paid or discounted against it.
    const existing = await prisma.feeAssignment.findUnique({
      where: { studentId_semesterId: { studentId, semesterId } },
      select: { id: true },
    });
    if (existing) {
      return fail(
        `Semester ${semester.semesterNumber} already has a fee assigned. Edit that assignment rather than adding a second one.`,
        { semesterId: ["Already assigned."] },
      );
    }

    const config = await getConfig();

    // A flat concession can never exceed the tuition it is discounting; the two
    // ways of quoting one are mutually exclusive, exactly as at enrollment.
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
        "There is nothing to charge — give a tuition rate, an exam fee or an activity fee. An assignment worth nothing would only show as a card of zeros.",
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
      completionDate: student.batch.completionDate,
      minCount: config.installmentMin,
      maxCount: config.installmentMax,
    });
    if (problem) return fail(problem, { rows: [problem] });

    // Everything the late fee depends on, read once outside the transaction:
    // these are policy tables, and a round trip per installment inside it is
    // what made this time out.
    const slabs = await prisma.lateFeeSlab.findMany({
      where: { isActive: true },
      orderBy: { minDaysOverdue: "asc" },
    });
    const now = new Date();
    const exempt = student.application.isProvisional;

    /**
     * A brand-new installment carries no payments and no discounts, so its
     * balance reduces to the slab that its lateness selects — no read needed.
     * One that is not yet due lands on zero and needs no write at all, since
     * that is what the column defaults to.
     */
    const lateFeeFor = (dueDate: Date, amountPaise: number): number =>
      exempt
        ? 0
        : computeLateFee({
            slabs,
            config,
            daysPastDue: chargeableDaysOverdue(dueDate, now, config.lateFeeEffectiveFrom),
            principalOutstandingPaise: amountPaise,
          });

    let backdated = 0;
    let lateFeeTotalPaise = 0;

    await prisma.$transaction(async (tx) => {
      const assignment = await tx.feeAssignment.create({
        data: {
          studentId,
          semesterId,
          academicYearId: semester.academicYearId,
          yearNumber: semester.yearNumber,
          lockedTuitionRatePaise,
          tuitionComponentPaise,
          scholarshipPercent,
          scholarshipAmountPaise,
          examFeePaise: parsed.data.examFee,
          activityFeePaise: parsed.data.activityFee,
          totalPayablePaise,
          note: note ?? null,
          createdById: actor.id,
        },
      });

      const written = await tx.installment.createManyAndReturn({
        select: { id: true, dueDate: true, amountPaise: true },
        data: plan.map((item) => ({ ...item, feeAssignmentId: assignment.id })),
      });

      // Group the back-dated rows by the fee they attract, so a plan of any
      // length costs at most one statement per distinct slab amount — and
      // nothing at all when none of them is chargeable yet.
      const byLateFee = new Map<number, string[]>();
      for (const installment of written) {
        const paise = lateFeeFor(installment.dueDate, installment.amountPaise);
        if (paise <= 0) continue;
        byLateFee.set(paise, [...(byLateFee.get(paise) ?? []), installment.id]);
      }
      for (const [lateFeePaise, ids] of byLateFee) {
        await tx.installment.updateMany({
          where: { id: { in: ids } },
          data: { lateFeePaise, lateFeeUpdatedAt: now },
        });
      }
      backdated = written.filter((installment) => installment.dueDate < startOfDay(now)).length;
      lateFeeTotalPaise = [...byLateFee].reduce((sum, [paise, ids]) => sum + paise * ids.length, 0);

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.assigned",
        entityType: "FeeAssignment",
        entityId: assignment.id,
        summary:
          `${formatPaise(totalPayablePaise)} assigned to ${student.studentCode} for semester ` +
          `${semester.semesterNumber} (year ${semester.yearNumber}) over ${plan.length} installment(s)`,
        reason: note ?? undefined,
        metadata: {
          semesterId,
          lockedTuitionRatePaise,
          scholarshipPercent,
          scholarshipAmountPaise,
          examFeePaise: parsed.data.examFee,
          activityFeePaise: parsed.data.activityFee,
          totalPayablePaise,
          installmentCount: plan.length,
          firstDueDate: plan[0].dueDate,
          lastDueDate: plan[plan.length - 1].dueDate,
          backdatedInstallments: backdated,
          lateFeeAssessedPaise: lateFeeTotalPaise,
        },
      });
    },
    // A handful of statements, but every one is a round trip to a hosted
    // database. Prisma's 5s default left no room for a slow link, which is what
    // made this fail in production.
    { timeout: 20_000 },
  );

    revalidatePath(`/students/${studentId}`);
    await notifyCampus(studentId, "FINANCE", "fee.assigned");
    revalidatePath("/students");
    revalidatePath("/fees/collect");
    revalidatePath("/reports/ledger");
    revalidatePath("/reports");
    return ok(
      undefined,
      `${formatPaise(totalPayablePaise)} assigned for semester ${semester.semesterNumber} over ${plan.length} ` +
        `installment(s), first due ${formatDate(plan[0].dueDate)}. It is collectible now and appears in Fee Due.` +
        (backdated > 0
          ? ` ${backdated} installment(s) were already past their due date${
              lateFeeTotalPaise > 0 ? ` and carry ${formatPaise(lateFeeTotalPaise)} in late fees` : ""
            }.`
          : ""),
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Assigned fee & installment schedule                                         */
/* -------------------------------------------------------------------------- */

const feeAssignmentSchema = z.object({
  assignmentId: requiredText("Fee assignment"),
  lockedTuitionRate: optionalRupeeAmount("Tuition rate"),
  scholarshipBasis: z.enum(["PERCENT", "AMOUNT"]).default("PERCENT"),
  scholarshipPercent: optionalIntInput("Scholarship", { min: 0, max: 100 }),
  scholarshipAmount: optionalRupeeAmount("Scholarship amount"),
  examFee: optionalRupeeAmount("Exam fee"),
  activityFee: optionalRupeeAmount("Activity fee"),
  /// JSON from the editor: [{ id?, dueDate: "yyyy-MM-dd", amount: "1234.00" }].
  rows: requiredText("Installments"),
  reason: reasonInput,
});

/**
 * Correct a student's assigned fee and its installment schedule.
 *
 * Enrollment fixes both from the Registrar's plan, and until now nothing could
 * change them afterwards — a mistyped tuition rate or due date was permanent.
 * The same rules the enrollment step enforces are re-applied here: the
 * installments must add up to the fee, run in date order, and finish on or
 * before the batch completion date.
 *
 * What money has already done is never overwritten. An installment cannot be
 * cut below what has been paid or discounted against it, and one carrying
 * payments, a discount or a waiver cannot be removed at all — those are undone
 * through their own audited actions first. Late fees are re-assessed afterwards
 * against the corrected dates.
 */
export async function updateFeeAssignmentAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_ASSIGN);
    const parsed = feeAssignmentSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { assignmentId, scholarshipBasis, reason } = parsed.data;
    const planned = parsePlanRows(parsed.data.rows);
    if ("error" in planned) return fail(planned.error);

    const assignment = await prisma.feeAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        semester: { select: { semesterNumber: true } },
        student: {
          select: {
            id: true,
            studentCode: true,
            batch: { select: { completionDate: true } },
            // Late fees are suspended while an admission is provisional, so the
            // recomputation below needs to know.
            application: { select: { isProvisional: true } },
          },
        },
        installments: {
          orderBy: { seqNo: "asc" },
          include: {
            payments: { where: { status: "ACTIVE" } },
            discounts: { where: { cancelledAt: null } },
          },
        },
      },
    });
    if (!assignment) return fail("Fee assignment not found.");

    const [config, slabs] = await Promise.all([
      getConfig(),
      prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
    ]);
    const student = assignment.student;

    // A flat concession can never exceed the tuition it is discounting; the two
    // ways of quoting one are mutually exclusive, exactly as at enrollment.
    const lockedTuitionRatePaise = parsed.data.lockedTuitionRate;
    const asAmount = scholarshipBasis === "AMOUNT";
    const scholarshipPercent = asAmount ? 0 : (parsed.data.scholarshipPercent ?? 0);
    const scholarshipAmountPaise = asAmount
      ? Math.min(parsed.data.scholarshipAmount, lockedTuitionRatePaise)
      : percentOf(lockedTuitionRatePaise, scholarshipPercent);
    const tuitionComponentPaise = lockedTuitionRatePaise - scholarshipAmountPaise;
    /** The semester fee itself — what the agreed plan has to add up to. */
    const semesterFeePaise = tuitionComponentPaise + parsed.data.examFee + parsed.data.activityFee;

    // Extra charges raised later are not part of the plan and are not edited
    // here — they are their own charges, with their own labels and waivers.
    // They still belong to this assignment's total, so what is assigned goes on
    // matching what the installments come to.
    const extras = assignment.installments.filter((installment) => installment.extraChargeKind !== null);
    const extrasPaise = extras.reduce((sum, installment) => sum + installment.amountPaise, 0);
    const totalPayablePaise = semesterFeePaise + extrasPaise;

    const rows = planned.rows;
    const drafts: InstallmentDraft[] = rows.map((row, index) => ({
      seqNo: index + 1,
      dueDate: row.dueDate,
      amountPaise: row.amountPaise,
    }));
    const problem = validateInstallmentPlan({
      rows: drafts,
      totalPayablePaise: semesterFeePaise,
      completionDate: student.batch.completionDate,
      minCount: config.installmentMin,
      maxCount: config.installmentMax,
    });
    if (problem) return fail(problem);

    const planned_ids = new Set(rows.map((row) => row.id).filter(Boolean));
    const regulars = assignment.installments.filter((installment) => installment.extraChargeKind === null);
    const existing = new Map(regulars.map((installment) => [installment.id, installment]));
    // Extras are never candidates for removal: the editor does not show them as
    // plan rows, so their absence from the submission means nothing.
    const kept = new Set([...planned_ids, ...extras.map((installment) => installment.id)]);

    for (const row of rows) {
      if (row.id && !existing.has(row.id)) {
        return fail("One of the installments is no longer on this fee assignment. Reload the page and try again.");
      }
    }

    // Money already moved against a row is the floor it cannot go below, and a
    // row carrying any of it cannot disappear.
    for (const installment of assignment.installments) {
      const paidPrincipal = installment.payments.reduce(
        (sum, payment) => sum + (payment.amountPaise - payment.lateFeePortionPaise),
        0,
      );
      const discounted = installment.discounts.reduce((sum, discount) => sum + discount.amountPaise, 0);
      const floor = paidPrincipal + discounted;
      const label = `Installment ${installment.seqNo}`;

      if (!kept.has(installment.id)) {
        if (installment.status === "WAIVED") {
          return fail(`${label} is waived — un-waive it before removing it from the plan.`);
        }
        if (paidPrincipal > 0 || installment.payments.length > 0) {
          return fail(`${label} has payments recorded against it and cannot be removed.`);
        }
        if (discounted > 0) {
          return fail(`${label} carries a discount — cancel the discount before removing it.`);
        }
        continue;
      }

      const row = rows.find((candidate) => candidate.id === installment.id);
      if (row && floor > 0 && row.amountPaise < floor) {
        return fail(
          `${label} already has ${formatPaise(floor)} paid or discounted against it, so it cannot be reduced to ${formatPaise(
            row.amountPaise,
          )}.`,
        );
      }
    }

    const before = {
      totalPayablePaise: assignment.totalPayablePaise,
      installmentCount: assignment.installments.length,
    };

    await prisma.$transaction(async (tx) => {
      await tx.feeAssignment.update({
        where: { id: assignmentId },
        data: {
          lockedTuitionRatePaise,
          scholarshipPercent,
          scholarshipAmountPaise,
          tuitionComponentPaise,
          examFeePaise: parsed.data.examFee,
          activityFeePaise: parsed.data.activityFee,
          totalPayablePaise,
        },
      });

      const removed = assignment.installments.filter((installment) => !kept.has(installment.id));
      if (removed.length > 0) {
        await tx.installment.deleteMany({ where: { id: { in: removed.map((i) => i.id) } } });
      }

      // `seqNo` is unique per assignment, so every surviving row is parked out of
      // the way before the final numbers are handed out — otherwise reordering or
      // closing a gap collides with a row not yet renumbered. Negating them all
      // at once keeps that to one statement; every row is given a positive
      // number again below.
      await tx.$executeRaw`
        UPDATE "Installment" SET "seqNo" = -"seqNo"
        WHERE "feeAssignmentId" = ${assignmentId} AND "seqNo" > 0
      `;

      /** Every surviving row with the values it now holds, for the recompute below. */
      const settled: { installment: (typeof assignment.installments)[number]; discountPaise: number }[] = [];

      for (const [index, row] of rows.entries()) {
        if (!row.id) continue;
        await tx.installment.update({
          where: { id: row.id },
          data: { seqNo: index + 1, dueDate: row.dueDate, amountPaise: row.amountPaise },
        });
        const original = existing.get(row.id)!;
        settled.push({
          installment: { ...original, seqNo: index + 1, dueDate: row.dueDate, amountPaise: row.amountPaise },
          discountPaise: original.discounts.reduce((sum, discount) => sum + discount.amountPaise, 0),
        });
      }

      const added = rows.flatMap((row, index) =>
        row.id
          ? []
          : [{ feeAssignmentId: assignmentId, seqNo: index + 1, dueDate: row.dueDate, amountPaise: row.amountPaise }],
      );
      if (added.length > 0) {
        // A row that has just been created carries no payments and no discounts.
        const created = await tx.installment.createManyAndReturn({ data: added });
        for (const installment of created) {
          settled.push({ installment: { ...installment, payments: [], discounts: [] }, discountPaise: 0 });
        }
      }

      // Extra charges keep their order and follow the plan.
      for (const [index, extra] of extras.entries()) {
        await tx.installment.update({ where: { id: extra.id }, data: { seqNo: rows.length + index + 1 } });
        settled.push({
          installment: { ...extra, seqNo: rows.length + index + 1 },
          discountPaise: extra.discounts.reduce((sum, discount) => sum + discount.amountPaise, 0),
        });
      }

      // Status, late fee and the cached discount all follow from the corrected
      // amounts and dates, so every surviving row is recomputed — from the copies
      // already in hand rather than a read apiece.
      const asOf = new Date();
      await refreshInstallmentsBulk(
        settled.map((entry) => ({
          installment: entry.installment,
          asOf,
          lateFeeExempt: student.application.isProvisional,
          discountPaise: entry.discountPaise,
        })),
        slabs,
        config,
        tx,
      );

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.assignment_updated",
        entityType: "FeeAssignment",
        entityId: assignmentId,
        summary:
          `Assigned fee for ${student.studentCode} (semester ${assignment.semester.semesterNumber}) corrected — ` +
          `${formatPaise(before.totalPayablePaise)} over ${before.installmentCount} installment(s) → ` +
          `${formatPaise(totalPayablePaise)} over ${rows.length}`,
        reason,
        metadata: {
          before,
          after: {
            lockedTuitionRatePaise,
            scholarshipPercent,
            scholarshipAmountPaise,
            examFeePaise: parsed.data.examFee,
            activityFeePaise: parsed.data.activityFee,
            semesterFeePaise,
            extraChargesPaise: extrasPaise,
            totalPayablePaise,
            installmentCount: rows.length,
          },
        },
      });
    }, {
      // One statement per installment is unavoidable here — each row gets its
      // own number, date and amount — so give the round trips room rather than
      // inherit a default that assumes a couple of queries.
      timeout: 20_000,
    });

    revalidatePath(`/students/${student.id}`);
    await notifyCampus(student.id, "FINANCE", "fee.assignment_updated");
    revalidatePath(`/students/${student.id}/fees/${assignmentId}`);
    revalidatePath("/fees/collect");
    revalidatePath("/reports/ledger");
    return ok(
      undefined,
      `Assigned fee updated — ${formatPaise(semesterFeePaise)} over ${rows.length} installment(s)` +
        `${extrasPaise > 0 ? `, plus ${formatPaise(extrasPaise)} in extra charges` : ""}. Late fees were re-assessed against the corrected due dates.`,
    );
  });
}

/**
 * Selectively restore a waived installment after reinstatement (spec 4.4).
 * The late fee is re-assessed against the original due date.
 */
export async function unwaiveInstallmentAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_WAIVE);
    const installmentId = String(formData.get("installmentId") ?? "");
    const parsedReason = reasonInput.safeParse(String(formData.get("reason") ?? ""));
    if (!parsedReason.success) {
      return fail("A reason is required.", { reason: [parsedReason.error.issues[0].message] });
    }

    const installment = await prisma.installment.findUnique({
      where: { id: installmentId },
      include: { feeAssignment: { include: { student: true } } },
    });
    if (!installment) return fail("Installment not found.");
    if (installment.status !== "WAIVED") return fail("This installment is not waived.");

    const student = installment.feeAssignment.student;
    if (student.status !== "ACTIVE") {
      return fail("Reinstate the student to Active before restoring waived installments.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.installment.update({
        where: { id: installmentId },
        data: {
          status: "PENDING",
          waivedAt: null,
          waivedById: null,
          waivedReason: null,
          waivedContext: null,
        },
      });
      // Re-assesses the late fee against the original due date.
      await refreshInstallment(installmentId, tx);

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.installment_unwaived",
        entityType: "Installment",
        entityId: installmentId,
        summary: `Installment ${installment.seqNo} for ${student.studentCode} restored after reinstatement`,
        reason: parsedReason.data,
        metadata: { amountPaise: installment.amountPaise, dueDate: installment.dueDate },
      });
    });

    revalidatePath(`/students/${student.id}`);
    await notifyCampus(student.id, "FINANCE", "fee.installment_restored");
    return ok(undefined, "Installment restored and late fee re-assessed against its original due date.");
  });
}

/** Waive a single installment outside a status change. */
export async function waiveInstallmentAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_WAIVE);
    const installmentId = String(formData.get("installmentId") ?? "");
    const parsedReason = reasonInput.safeParse(String(formData.get("reason") ?? ""));
    if (!parsedReason.success) {
      return fail("A reason is required.", { reason: [parsedReason.error.issues[0].message] });
    }

    const installment = await prisma.installment.findUnique({
      where: { id: installmentId },
      include: { feeAssignment: { include: { student: true } } },
    });
    if (!installment) return fail("Installment not found.");
    if (installment.status === "WAIVED") return fail("This installment is already waived.");
    if (installment.status === "PAID") return fail("A fully paid installment cannot be waived.");

    await prisma.$transaction(async (tx) => {
      await tx.installment.update({
        where: { id: installmentId },
        data: {
          status: "WAIVED",
          waivedAt: new Date(),
          waivedById: actor.id,
          waivedReason: parsedReason.data,
          waivedContext: "MANUAL",
          lateFeePaise: 0,
        },
      });
      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.installment_waived",
        entityType: "Installment",
        entityId: installmentId,
        summary: `Installment ${installment.seqNo} for ${installment.feeAssignment.student.studentCode} waived`,
        reason: parsedReason.data,
        metadata: { amountPaise: installment.amountPaise },
      });
    });

    revalidatePath(`/students/${installment.feeAssignment.studentId}`);
    await notifyCampus(installment.feeAssignment.studentId, "FINANCE", "fee.installment_waived");
    return ok(undefined, "Installment waived.");
  });
}

/** Toggle the informational backlog/reappear flag (spec 6.3). */
export async function toggleBacklogAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.STUDENT_STATUS_CHANGE);
    const studentId = String(formData.get("studentId") ?? "");
    const remark = String(formData.get("remark") ?? "").trim() || null;

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) return fail("Student not found.");

    const next = !student.hasBacklog;
    await prisma.student.update({
      where: { id: studentId },
      data: { hasBacklog: next, backlogRemark: next ? remark : null },
    });

    await prisma.$transaction(async (tx) => {
      await recordAuditTx(tx, {
        userId: actor.id,
        action: "student.backlog_toggled",
        entityType: "Student",
        entityId: studentId,
        summary: `Backlog flag ${next ? "set" : "cleared"} for ${student.studentCode}`,
        reason: remark,
      });
    });

    revalidatePath(`/students/${studentId}`);
    return ok(undefined, next ? "Backlog flag set." : "Backlog flag cleared.");
  });
}

/* -------------------------------------------------------------------------- */
/* Discounts                                                                   */
/* -------------------------------------------------------------------------- */

const discountSchema = z
  .object({
    studentId: requiredText("Student"),
    /** Required when the scope is a single installment. */
    installmentId: optionalText,
    scope: z.enum(["INSTALLMENT", "ALL_UNPAID"]),
    reason: z.enum(["EARLY_PAYMENT", "FINANCIAL_HARDSHIP", "MERIT", "SIBLING", "STAFF_WARD", "OTHER"]),
    /** Exactly one of these is supplied; the form shows a toggle. */
    percent: optionalText,
    amount: optionalText,
    note: reasonInput,
  })
  .refine((data) => Boolean(data.percent?.trim()) !== Boolean(data.amount?.trim()), {
    message: "Give either a percentage or an amount, not both.",
    path: ["amount"],
  })
  .refine((data) => data.scope === "ALL_UNPAID" || Boolean(data.installmentId?.trim()), {
    message: "Choose an installment.",
    path: ["installmentId"],
  });

/** What is still chargeable on an installment, after payments and earlier discounts. */
function discountRoom(installment: {
  amountPaise: number;
  payments: { status: string; amountPaise: number; lateFeePortionPaise: number }[];
  discounts: { amountPaise: number }[];
}): number {
  const discounted = installment.discounts.reduce((sum, d) => sum + d.amountPaise, 0);
  const paid = installment.payments
    .filter((p) => p.status === "ACTIVE")
    .reduce((sum, p) => sum + (p.amountPaise - p.lateFeePortionPaise), 0);
  return installment.amountPaise - discounted - paid;
}

/**
 * Grant a concession, either on one installment or across every unpaid one
 * (early payment, financial hardship and so on). Admin only, justification
 * mandatory.
 *
 * A discount reduces what is owed; it never touches the assigned fee, so the
 * ledger still shows the full charge with the concession as a separate credit.
 *
 * Given as a percentage, it applies to each installment in scope on its own
 * amount. Given as a figure with the whole-balance scope, that figure is the
 * total concession and is spread oldest due date first — "take five thousand off
 * what they owe", not "five thousand off every installment".
 *
 * One Discount row is written per installment either way, so each stays
 * individually reversible and the ledger shows where the money went.
 */
export async function grantDiscountAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_DISCOUNT);
    const parsed = discountSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { studentId, installmentId, scope, reason, note } = parsed.data;

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        studentCode: true,
        status: true,
        // Late fees are suspended while an admission is provisional.
        application: { select: { isProvisional: true } },
      },
    });
    if (!student) return fail("Student not found.");
    if (student.status !== "ACTIVE" && student.status !== "PASSED") {
      return fail("Discounts can only be granted to an active student.");
    }

    const candidates = await prisma.installment.findMany({
      where: {
        feeAssignment: { studentId },
        status: { notIn: ["PAID", "WAIVED"] },
        ...(scope === "INSTALLMENT" ? { id: installmentId! } : {}),
      },
      include: {
        payments: true,
        discounts: { where: { cancelledAt: null } },
        feeAssignment: { include: { semester: true } },
      },
      orderBy: [{ dueDate: "asc" }, { seqNo: "asc" }],
    });

    if (scope === "INSTALLMENT" && candidates.length === 0) {
      return fail("That installment is already paid or waived, so there is nothing to discount.");
    }

    const open = candidates.filter((installment) => discountRoom(installment) > 0);
    if (open.length === 0) {
      return fail(
        scope === "INSTALLMENT"
          ? "This installment is already settled by payments and discounts — there is nothing left to discount."
          : `${student.studentCode} has no unpaid installments left to discount.`,
      );
    }

    const totalRoom = open.reduce((sum, installment) => sum + discountRoom(installment), 0);

    // Work out what each installment gets.
    let percent: number | null = null;
    const shares: { installment: (typeof open)[number]; amountPaise: number }[] = [];

    if (parsed.data.percent?.trim()) {
      const value = Number(parsed.data.percent.trim());
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        return fail("The percentage must be a whole number between 1 and 100.", { percent: ["1 to 100."] });
      }
      percent = value;
      for (const installment of open) {
        // Capped by what is left chargeable, so a part-paid installment cannot
        // be discounted below zero.
        const share = Math.min(percentOf(installment.amountPaise, value), discountRoom(installment));
        if (share > 0) shares.push({ installment, amountPaise: share });
      }
    } else {
      const value = Number((parsed.data.amount ?? "").replace(/[,\s₹]/g, ""));
      if (!Number.isFinite(value) || value <= 0) {
        return fail("The amount must be a positive number.", { amount: ["Enter an amount above zero."] });
      }
      const requested = rupeesToPaise(value);
      if (requested > totalRoom) {
        return fail(
          scope === "INSTALLMENT"
            ? `That is more than the ${formatPaise(totalRoom)} still outstanding on this installment.`
            : `That is more than the ${formatPaise(totalRoom)} ${student.studentCode} still owes across their unpaid installments.`,
          { amount: [`Maximum ${formatPaise(totalRoom)}.`] },
        );
      }
      let remaining = requested;
      for (const installment of open) {
        if (remaining <= 0) break;
        const share = Math.min(remaining, discountRoom(installment));
        if (share > 0) {
          shares.push({ installment, amountPaise: share });
          remaining -= share;
        }
      }
    }

    if (shares.length === 0) return fail("That works out to nothing on any installment.");
    const granted = shares.reduce((sum, share) => sum + share.amountPaise, 0);

    const [slabs, config] = await Promise.all([
      prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
      getConfig(),
    ]);
    const exempt = student.application.isProvisional;

    await prisma.$transaction(async (tx) => {
      await tx.discount.createMany({
        data: shares.map((share) => ({
          installmentId: share.installment.id,
          studentId: student.id,
          reason,
          percent,
          amountPaise: share.amountPaise,
          note,
          grantedById: actor.id,
        })),
      });

      // Recomputes the cached discount, the status and the late fee, which now
      // accrues on the reduced balance. A concession across a whole balance can
      // touch every unpaid installment, so the rows go together rather than a
      // read and a write apiece.
      const asOf = new Date();
      await refreshInstallmentsBulk(
        shares.map((share) => ({
          installment: share.installment,
          asOf,
          lateFeeExempt: exempt,
          // The row just written is not on the copy in hand, so add it to
          // whatever was already granted against this installment.
          discountPaise:
            share.installment.discounts.reduce((sum, discount) => sum + discount.amountPaise, 0) + share.amountPaise,
        })),
        slabs,
        config,
        tx,
      );

      const where =
        shares.length === 1
          ? `semester ${shares[0].installment.feeAssignment.semester.semesterNumber} installment ${shares[0].installment.seqNo}`
          : `${shares.length} unpaid installments`;

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.discount_granted",
        entityType: "Student",
        entityId: student.id,
        summary:
          `${formatPaise(granted)}${percent ? ` (${percent}%)` : ""} discount granted to ${student.studentCode} ` +
          `on ${where} — ${reason.replaceAll("_", " ").toLowerCase()}`,
        reason: note,
        metadata: {
          scope,
          percent,
          totalPaise: granted,
          discountReason: reason,
          installments: shares.map((share) => ({
            installmentId: share.installment.id,
            seqNo: share.installment.seqNo,
            amountPaise: share.amountPaise,
          })),
        },
      });
    });

    revalidatePath(`/students/${student.id}`);
    await notifyCampus(student.id, "FINANCE", "fee.discount_granted");
    revalidatePath("/reports");
    return ok(
      undefined,
      shares.length === 1
        ? `${formatPaise(granted)} discount granted. The installment balance has been updated.`
        : `${formatPaise(granted)} discount granted across ${shares.length} installments.`,
    );
  });
}

/** Reverse a discount. Like a receipt it is voided, never deleted. */
export async function cancelDiscountAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_DISCOUNT);
    const discountId = String(formData.get("discountId") ?? "");
    const parsedReason = reasonInput.safeParse(String(formData.get("reason") ?? ""));
    if (!parsedReason.success) {
      return fail("A reason is required.", { reason: [parsedReason.error.issues[0].message] });
    }

    const discount = await prisma.discount.findUnique({
      where: { id: discountId },
      include: { student: { select: { id: true, studentCode: true } } },
    });
    if (!discount) return fail("Discount not found.");
    if (discount.cancelledAt) return fail("This discount is already cancelled.");

    await prisma.$transaction(async (tx) => {
      await tx.discount.update({
        where: { id: discountId },
        data: {
          cancelledAt: new Date(),
          cancelledById: actor.id,
          cancellationReason: parsedReason.data,
        },
      });
      // The money comes back onto the installment, and the late fee is
      // re-assessed against the original due date on the restored balance.
      await refreshInstallment(discount.installmentId, tx);

      // A late fee credit cancelled here releases the fine it came from: the
      // family is once again holding nothing back, so that late fee can be
      // restored without charging them for it twice.
      if (discount.lateFeeSourceInstallmentId) {
        await tx.installment.update({
          where: { id: discount.lateFeeSourceInstallmentId },
          data: { lateFeeCreditedPaise: { decrement: discount.amountPaise } },
        });
      }

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.discount_cancelled",
        entityType: "Installment",
        entityId: discount.installmentId,
        summary:
          `${formatPaise(discount.amountPaise)} ${
            discount.reason === "LATE_FEE_ADJUSTMENT" ? "late fee credit" : "discount"
          } for ${discount.student.studentCode} cancelled`,
        reason: parsedReason.data,
        metadata: {
          discountId,
          amountPaise: discount.amountPaise,
          lateFeeSourceInstallmentId: discount.lateFeeSourceInstallmentId,
        },
      });
    });

    revalidatePath(`/students/${discount.student.id}`);
    await notifyCampus(discount.student.id, "FINANCE", "fee.discount_cancelled");
    revalidatePath("/reports");
    revalidatePath("/reports/ledger");
    return ok(
      undefined,
      discount.reason === "LATE_FEE_ADJUSTMENT"
        ? "Credit cancelled. The amount is payable again, and the late fee it came from can now be restored."
        : "Discount cancelled. The amount is payable again.",
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Late fee waiver                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Write off the late fee on one installment while the principal stands.
 *
 * Open to the Accountant as well as the Admin: it is a counter decision, taken
 * while the family is paying, and it does not change what they owe in fees. The
 * flag also stops the nightly job re-applying the charge.
 *
 * A late fee that has **already been collected** can be waived too — the common
 * case being a receipt issued at the counter with the fine in it, and the
 * decision to let the family off taken afterwards. That money is not refunded
 * and the receipt is not touched: it becomes a credit against what they owe
 * next, oldest installment first, so the next payment is smaller by exactly the
 * fine. The ledger keeps the fine as a debit and shows the credit on its own
 * line, which is what actually happened.
 */
export async function waiveLateFeeAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_WAIVE_LATE_FEE);
    const installmentId = String(formData.get("installmentId") ?? "");
    const rawAmount = String(formData.get("amount") ?? "").trim();
    const parsedReason = reasonInput.safeParse(String(formData.get("reason") ?? ""));
    if (!parsedReason.success) {
      return fail("A reason is required.", { reason: [parsedReason.error.issues[0].message] });
    }

    const installment = await prisma.installment.findUnique({
      where: { id: installmentId },
      include: {
        payments: true,
        feeAssignment: {
          include: {
            semester: true,
            student: {
              select: { id: true, studentCode: true, application: { select: { isProvisional: true } } },
            },
          },
        },
      },
    });
    if (!installment) return fail("Installment not found.");
    if (installment.status === "WAIVED") {
      return fail("This installment is waived in full, so its late fee is already cancelled.");
    }

    const [slabs, config] = await Promise.all([
      prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
      getConfig(),
    ]);
    const student = installment.feeAssignment.student;
    const balance = balanceOf(installment, slabs, config, new Date(), student.application.isProvisional);

    // Two pots, and the whole of both can be waived: what is still owed in late
    // fee, and what has already been collected against it and not yet credited
    // back.
    const unpaidRoom = balance.lateFeeOutstandingPaise;
    const collectedRoom = Math.max(0, balance.lateFeePaidPaise - installment.lateFeeCreditedPaise);
    const room = unpaidRoom + collectedRoom;
    if (room <= 0) {
      return fail(
        installment.lateFeeWaived || installment.lateFeeCreditedPaise > 0
          ? "The late fee on this installment is already waived."
          : "There is no late fee on this installment to waive.",
      );
    }

    // Blank means the whole of it.
    let waivePaise = room;
    if (rawAmount) {
      const value = Number(rawAmount.replace(/[,\s₹]/g, ""));
      if (!Number.isFinite(value) || value <= 0) {
        return fail("The amount must be a positive number.", { amount: ["Enter an amount above zero."] });
      }
      waivePaise = rupeesToPaise(value);
      if (waivePaise > room) {
        return fail(
          collectedRoom > 0
            ? `That is more than the ${formatPaise(room)} late fee on this installment — ${formatPaise(
                unpaidRoom,
              )} outstanding and ${formatPaise(collectedRoom)} already collected.`
            : `That is more than the ${formatPaise(room)} late fee outstanding on this installment.`,
          { amount: [`Maximum ${formatPaise(room)}.`] },
        );
      }
    }

    // What is still owed is written off first; only what the family has actually
    // handed over needs crediting back to them.
    const writeOffPaise = Math.min(waivePaise, unpaidRoom);
    const creditPaise = waivePaise - writeOffPaise;

    // Where the credit goes: their unpaid installments, oldest due date first —
    // the very ones the next payment would settle. The installment the fine sat
    // on is included; if it still has principal owing, that is where the next
    // payment lands anyway.
    const openInstallments =
      creditPaise > 0
        ? await prisma.installment.findMany({
            where: { feeAssignment: { studentId: student.id }, status: { notIn: ["PAID", "WAIVED"] } },
            include: {
              payments: true,
              discounts: { where: { cancelledAt: null } },
              feeAssignment: { include: { semester: true } },
            },
            orderBy: [{ dueDate: "asc" }, { seqNo: "asc" }],
          })
        : [];
    const creditTargets = openInstallments.filter((candidate) => discountRoom(candidate) > 0);
    const creditRoom = creditTargets.reduce((sum, candidate) => sum + discountRoom(candidate), 0);

    if (creditPaise > creditRoom) {
      return fail(
        creditRoom === 0
          ? `${formatPaise(creditPaise)} of this late fee has already been collected, and ${student.studentCode} has no unpaid installment left to set it against. It would have to be refunded, which is handled outside the system — waive ${
              unpaidRoom > 0 ? `up to ${formatPaise(unpaidRoom)} here, or ` : ""
            }wait until the next installment falls due.`
          : `${formatPaise(creditPaise)} of this late fee has already been collected, but only ${formatPaise(
              creditRoom,
            )} is left unpaid to set it against. Waive up to ${formatPaise(unpaidRoom + creditRoom)}.`,
        { amount: [`Maximum ${formatPaise(unpaidRoom + creditRoom)}.`] },
      );
    }

    const creditShares: { installment: (typeof creditTargets)[number]; amountPaise: number }[] = [];
    let remainingCredit = creditPaise;
    for (const candidate of creditTargets) {
      if (remainingCredit <= 0) break;
      const share = Math.min(remainingCredit, discountRoom(candidate));
      if (share > 0) {
        creditShares.push({ installment: candidate, amountPaise: share });
        remainingCredit -= share;
      }
    }

    // Writing off the whole of it also stops anything further accruing, so a
    // family told "the late fee is waived" does not see it creep back as the
    // installment ages into the next slab.
    const inFull = waivePaise >= room;
    const totalWaived = installment.lateFeeWaivedPaise + writeOffPaise;

    const source = `semester ${installment.feeAssignment.semester.semesterNumber} installment ${installment.seqNo}`;

    await prisma.$transaction(async (tx) => {
      await tx.installment.update({
        where: { id: installmentId },
        data: {
          lateFeeWaivedPaise: totalWaived,
          lateFeeCreditedPaise: installment.lateFeeCreditedPaise + creditPaise,
          lateFeeWaived: inFull,
          lateFeeWaivedAt: new Date(),
          lateFeeWaivedById: actor.id,
          lateFeeWaivedReason: parsedReason.data,
        },
      });
      await refreshInstallment(installmentId, tx);

      // The collected part comes back to the family as a credit, not as cash.
      // One Discount row per installment it lands on, exactly as a concession
      // would be — so it shows on the ledger, reduces the next payment, and can
      // be reversed on its own if the waiver was a mistake.
      for (const share of creditShares) {
        await tx.discount.create({
          data: {
            installmentId: share.installment.id,
            lateFeeSourceInstallmentId: installmentId,
            studentId: student.id,
            reason: "LATE_FEE_ADJUSTMENT",
            percent: null,
            amountPaise: share.amountPaise,
            note:
              `Late fee of ${formatPaise(creditPaise)} on ${source} was waived after it had been collected. ` +
              `Adjusted against this installment instead of being refunded. ${parsedReason.data}`,
            grantedById: actor.id,
          },
        });
        await refreshInstallment(share.installment.id, tx);
      }

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.late_fee_waived",
        entityType: "Installment",
        entityId: installmentId,
        summary:
          `Late fee of ${formatPaise(waivePaise)}${inFull ? " (in full)" : " (part)"} waived for ${student.studentCode} ` +
          `on ${source}` +
          (creditPaise > 0
            ? ` — ${formatPaise(creditPaise)} of it already collected and credited against ${creditShares.length} unpaid installment(s)`
            : ""),
        reason: parsedReason.data,
        metadata: {
          waivedPaise: waivePaise,
          writtenOffPaise: writeOffPaise,
          creditedPaise: creditPaise,
          assessedPaise: balance.lateFeeAssessedPaise,
          inFull,
          dueDate: installment.dueDate,
          credits: creditShares.map((share) => ({
            installmentId: share.installment.id,
            seqNo: share.installment.seqNo,
            amountPaise: share.amountPaise,
          })),
        },
      });
    });

    revalidatePath(`/students/${student.id}`);
    await notifyCampus(student.id, "FINANCE", "fee.late_fee_waived");
    revalidatePath("/fees/collect");
    revalidatePath("/reports");
    // The waiver can now be taken from the ledger itself, which is its own page
    // under /reports and so is not covered by the line above.
    revalidatePath("/reports/ledger");
    const creditNote =
      creditPaise > 0
        ? ` ${formatPaise(creditPaise)} of it had already been collected — that receipt stands, and the amount is credited against ${
            creditShares.length === 1
              ? `the ${formatDate(creditShares[0].installment.dueDate)} installment`
              : `the next ${creditShares.length} installments`
          }, so the next payment is smaller by exactly that much.`
        : "";

    return ok(
      undefined,
      (inFull
        ? `Late fee of ${formatPaise(waivePaise)} waived in full. No further late fee will accrue on this installment.`
        : `${formatPaise(waivePaise)} of the late fee waived — ${formatPaise(room - waivePaise)} still payable.`) +
        creditNote,
    );
  });
}

/** Put the late fee back. It is re-assessed against the original due date. */
export async function restoreLateFeeAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_WAIVE_LATE_FEE);
    const installmentId = String(formData.get("installmentId") ?? "");
    const parsedReason = reasonInput.safeParse(String(formData.get("reason") ?? ""));
    if (!parsedReason.success) {
      return fail("A reason is required.", { reason: [parsedReason.error.issues[0].message] });
    }

    const installment = await prisma.installment.findUnique({
      where: { id: installmentId },
      include: { feeAssignment: { include: { semester: true, student: { select: { id: true, studentCode: true } } } } },
    });
    if (!installment) return fail("Installment not found.");
    if (!installment.lateFeeWaived && installment.lateFeeWaivedPaise === 0 && installment.lateFeeCreditedPaise === 0) {
      return fail("No late fee has been waived on this installment.");
    }
    // Part of this fee was collected and handed back as a credit against other
    // installments. Restoring it while that credit stands would charge the
    // family for the same fine twice, so the credit goes first.
    if (installment.lateFeeCreditedPaise > 0) {
      return fail(
        `${formatPaise(installment.lateFeeCreditedPaise)} of this late fee had already been collected and was credited against the student's unpaid installments. Cancel that credit — it is listed as a discount on the installment it landed on — before restoring the fee.`,
      );
    }

    const student = installment.feeAssignment.student;

    const balance = await prisma.$transaction(async (tx) => {
      await tx.installment.update({
        where: { id: installmentId },
        data: {
          lateFeeWaivedPaise: 0,
          lateFeeWaived: false,
          lateFeeWaivedAt: null,
          lateFeeWaivedById: null,
          lateFeeWaivedReason: null,
        },
      });
      // Re-assessed against the original due date, so the slab that applies is
      // the one the delay actually earned.
      const restored = await refreshInstallment(installmentId, tx);

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.late_fee_restored",
        entityType: "Installment",
        entityId: installmentId,
        summary:
          `Late fee restored for ${student.studentCode} on semester ` +
          `${installment.feeAssignment.semester.semesterNumber} installment ${installment.seqNo} — ` +
          `${formatPaise(restored?.lateFeeAssessedPaise ?? 0)} re-assessed`,
        reason: parsedReason.data,
        metadata: { restoredLateFeePaise: restored?.lateFeeAssessedPaise ?? 0 },
      });

      return restored;
    });

    revalidatePath(`/students/${student.id}`);
    await notifyCampus(student.id, "FINANCE", "fee.late_fee_restored");
    revalidatePath("/fees/collect");
    revalidatePath("/reports");
    // Putting the charge back changes what the ledger shows as outstanding.
    revalidatePath("/reports/ledger");
    return ok(undefined, `Late fee restored — ${formatPaise(balance?.lateFeeAssessedPaise ?? 0)} re-assessed.`);
  });
}
