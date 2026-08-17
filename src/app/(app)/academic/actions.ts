"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { startOfDay } from "@/lib/dates";
import { getConfig } from "@/lib/config";
import { formatPaise } from "@/lib/money";
import { semesterLayout } from "@/lib/academic";
import { reflowInstallmentsForBatch } from "@/lib/fees";
import {
  dateInput,
  fieldErrorsOf,
  formObject,
  intInput,
  optionalRupeeAmount,
  optionalText,
  requiredText,
  rupeeAmount,
} from "@/lib/validation";

/* -------------------------------------------------------------------------- */
/* 5.1 Departments                                                             */
/* -------------------------------------------------------------------------- */

const departmentSchema = z.object({
  id: optionalText,
  name: requiredText("Department name", 2),
  code: requiredText("Code", 1).transform((v) => v.toUpperCase()),
  headOfDepartment: optionalText,
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

export async function saveDepartmentAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const parsed = departmentSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, ...data } = parsed.data;
    const clash = await prisma.department.findFirst({ where: { code: data.code, ...(id ? { NOT: { id } } : {}) } });
    if (clash) return fail("That code is already used.", { code: ["Already in use."] });

    if (id && data.status === "INACTIVE") {
      const active = await prisma.student.count({ where: { departmentId: id, status: "ACTIVE" } });
      if (active > 0) {
        return fail(`${active} active student(s) belong to this department. Deactivating it is blocked.`);
      }
    }

    if (id) {
      await prisma.department.update({ where: { id }, data });
    } else {
      await prisma.department.create({ data });
    }

    await recordAudit({
      userId: actor.id,
      action: id ? "academic.department_updated" : "academic.department_created",
      entityType: "Department",
      entityId: id,
      summary: `Department ${data.code} — ${data.name} saved`,
    });
    revalidatePath("/academic/departments");
    return ok(undefined, "Department saved.");
  });
}

export async function deleteDepartmentAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const id = String(formData.get("id") ?? "");
    const department = await prisma.department.findUnique({
      where: { id },
      include: { _count: { select: { students: true, courses: true } } },
    });
    if (!department) return fail("Department not found.");

    // Spec 5.5 — never delete something students or courses hang off.
    if (department._count.students > 0 || department._count.courses > 0) {
      return fail(
        `This department has ${department._count.courses} course(s) and ${department._count.students} student record(s). Deactivate it instead.`,
      );
    }

    await prisma.department.delete({ where: { id } });
    await recordAudit({
      userId: actor.id,
      action: "academic.department_deleted",
      entityType: "Department",
      entityId: id,
      summary: `Department ${department.code} deleted`,
    });
    revalidatePath("/academic/departments");
    return ok(undefined, "Department deleted.");
  });
}

/* -------------------------------------------------------------------------- */
/* 5.2 Courses                                                                 */
/* -------------------------------------------------------------------------- */

const courseSchema = z.object({
  id: optionalText,
  name: requiredText("Course name", 2),
  code: requiredText("Code", 1).transform((v) => v.toUpperCase()),
  departmentId: requiredText("Department"),
  durationYears: intInput("Duration (years)", { min: 1, max: 10 }),
  // Spec 5.2 — single-semester courses are not allowed.
  totalSemesters: intInput("Total semesters", { min: 2, max: 20 }),
  registrationFeePaise: rupeeAmount("Registration fee", { min: 0 }),
  status: z.enum(["ACTIVE", "INACTIVE", "DISCONTINUED"]),
});

export async function saveCourseAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const parsed = courseSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, ...data } = parsed.data;
    const clash = await prisma.course.findFirst({ where: { code: data.code, ...(id ? { NOT: { id } } : {}) } });
    if (clash) return fail("That code is already used.", { code: ["Already in use."] });

    const department = await prisma.department.findUnique({ where: { id: data.departmentId } });
    if (!department) return fail("Select a valid department.", { departmentId: ["Unknown department."] });

    // The institute-wide figure is the floor, here as on the batch: a course may
    // charge more to register but never less.
    const config = await getConfig();
    if (data.registrationFeePaise < config.minRegistrationFeePaise) {
      return fail(
        `The registration fee cannot be below the institute minimum of ${formatPaise(
          config.minRegistrationFeePaise,
        )}.`,
        { registrationFeePaise: [`Minimum ${formatPaise(config.minRegistrationFeePaise)}.`] },
      );
    }

    if (id) {
      const existing = await prisma.course.findUnique({
        where: { id },
        include: { _count: { select: { batches: true, students: true } } },
      });
      if (!existing) return fail("Course not found.");

      // Changing the semester count after batches exist would desynchronise the
      // semester rows those batches already carry.
      if (existing.totalSemesters !== data.totalSemesters && existing._count.batches > 0) {
        return fail(
          `${existing._count.batches} batch(es) already exist under this course, so the semester count cannot change.`,
          { totalSemesters: ["Locked once batches exist."] },
        );
      }
      if (data.status === "INACTIVE") {
        const active = await prisma.student.count({ where: { courseId: id, status: "ACTIVE" } });
        if (active > 0) return fail(`${active} active student(s) are enrolled in this course.`);
      }

      await prisma.course.update({ where: { id }, data });
    } else {
      await prisma.course.create({ data });
    }

    await recordAudit({
      userId: actor.id,
      action: id ? "academic.course_updated" : "academic.course_created",
      entityType: "Course",
      entityId: id,
      summary: `Course ${data.code} — ${data.name} saved (status ${data.status})`,
    });
    revalidatePath("/academic/courses");
    return ok(undefined, "Course saved.");
  });
}

export async function deleteCourseAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const id = String(formData.get("id") ?? "");
    const course = await prisma.course.findUnique({
      where: { id },
      include: { _count: { select: { batches: true, students: true } } },
    });
    if (!course) return fail("Course not found.");
    if (course._count.batches > 0 || course._count.students > 0) {
      return fail(
        `This course has ${course._count.batches} batch(es) and ${course._count.students} student record(s). Mark it Discontinued instead.`,
      );
    }

    await prisma.course.delete({ where: { id } });
    await recordAudit({
      userId: actor.id,
      action: "academic.course_deleted",
      entityType: "Course",
      entityId: id,
      summary: `Course ${course.code} deleted`,
    });
    revalidatePath("/academic/courses");
    return ok(undefined, "Course deleted.");
  });
}

/* -------------------------------------------------------------------------- */
/* 5.3 Batches                                                                 */
/* -------------------------------------------------------------------------- */

const batchSchema = z
  .object({
    id: optionalText,
    name: requiredText("Batch name", 2),
    code: requiredText("Code", 1).transform((v) => v.toUpperCase()),
    courseId: requiredText("Course"),
    startDate: dateInput("Start date"),
    completionDate: dateInput("Completion date"),
    totalSeats: intInput("Total seats", { min: 1, max: 10000 }),
    tuitionFeePaise: rupeeAmount("Preset batch fee", { min: 0 }),
    // Blank is the ordinary case: the batch then follows its course.
    registrationFeePaise: optionalRupeeAmount("Registration fee override"),
    status: z.enum(["UPCOMING", "ONGOING", "COMPLETED", "DISCONTINUED"]),
  })
  .refine((data) => data.completionDate > data.startDate, {
    message: "Completion date must be after the start date.",
    path: ["completionDate"],
  });

export async function saveBatchAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const parsed = batchSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, tuitionFeePaise, ...data } = parsed.data;

    // Only when an override is actually given — blank means "follow the course",
    // which is the ordinary case and needs no checking here.
    const config = await getConfig();
    if (data.registrationFeePaise !== null) {
      if (data.registrationFeePaise < config.minRegistrationFeePaise) {
        return fail(
          `The registration fee cannot be below the institute minimum of ${formatPaise(
            config.minRegistrationFeePaise,
          )}.`,
          { registrationFeePaise: [`Minimum ${formatPaise(config.minRegistrationFeePaise)}.`] },
        );
      }
      // Installment 1 is this amount and the plan has to add up to the batch's
      // fee, so an override above the tuition could never be scheduled.
      if (data.registrationFeePaise > tuitionFeePaise) {
        return fail(
          `The registration fee cannot exceed the batch fee of ${formatPaise(
            tuitionFeePaise,
          )} — installment 1 is the registration fee.`,
          { registrationFeePaise: [`Maximum ${formatPaise(tuitionFeePaise)}.`] },
        );
      }
    }

    const clash = await prisma.batch.findFirst({ where: { code: data.code, ...(id ? { NOT: { id } } : {}) } });
    if (clash) return fail("That code is already used.", { code: ["Already in use."] });

    const course = await prisma.course.findUnique({ where: { id: data.courseId } });
    if (!course) return fail("Select a valid course.", { courseId: ["Unknown course."] });
    // Spec 5.2 — existing batches continue, but no new ones under a discontinued course.
    if (!id && course.status === "DISCONTINUED") {
      return fail("New batches cannot be created under a discontinued course.", {
        courseId: ["This course is discontinued."],
      });
    }

    let warning: string | undefined;

    if (id) {
      const existing = await prisma.batch.findUnique({ where: { id } });
      if (!existing) return fail("Batch not found.");

      const enrolled = await prisma.student.count({ where: { batchId: id } });
      if (data.totalSeats < enrolled) {
        return fail(`${enrolled} student(s) are already enrolled — capacity cannot drop below that.`, {
          totalSeats: [`Minimum ${enrolled}.`],
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.batch.update({ where: { id }, data });

        // A changed preset fee is a new version, not an overwrite — students
        // already enrolled keep the rate locked at their enrollment date.
        const latest = await tx.batchFeeHistory.findFirst({
          where: { batchId: id },
          orderBy: { effectiveFrom: "desc" },
        });
        if (!latest || latest.tuitionFeePaise !== tuitionFeePaise) {
          const effectiveFrom = startOfDay(new Date());
          await tx.batchFeeHistory.upsert({
            where: { batchId_effectiveFrom: { batchId: id, effectiveFrom } },
            update: { tuitionFeePaise, createdById: actor.id, note: "Revised via batch edit" },
            create: {
              batchId: id,
              tuitionFeePaise,
              effectiveFrom,
              note: "Revised via batch edit",
              createdById: actor.id,
            },
          });
        }

        // Spec 2.6 — shifting the completion date re-flows existing due dates.
        if (existing.completionDate.getTime() !== data.completionDate.getTime()) {
          const result = await reflowInstallmentsForBatch(id, data.completionDate, tx);
          if (result.adjusted > 0) {
            warning = `${result.adjusted} installment due date(s) were moved to fit the new completion date.`;
          }
          if (result.couldNotFit > 0) {
            warning = `${warning ?? ""} ${result.couldNotFit} plan(s) could not be spaced properly — the remaining installments now fall very close together.`.trim();
          }
        }
      });

      await recordAudit({
        userId: actor.id,
        action: "academic.batch_updated",
        entityType: "Batch",
        entityId: id,
        summary: `Batch ${data.code} updated`,
        metadata: { tuitionFeePaise, completionDate: data.completionDate },
      });
      revalidatePath("/academic/batches");
      revalidatePath(`/academic/batches/${id}`);
      return ok(undefined, warning ? `Batch saved. ${warning}` : "Batch saved.");
    }

    // New batch: create it, seed its fee history, and lay out its semesters.
    const slots = semesterLayout({
      startDate: data.startDate,
      completionDate: data.completionDate,
      totalSemesters: course.totalSemesters,
      durationYears: course.durationYears,
    });
    const created = await prisma.$transaction(async (tx) => {
      const batch = await tx.batch.create({ data });

      await tx.batchFeeHistory.create({
        data: {
          batchId: batch.id,
          tuitionFeePaise,
          effectiveFrom: startOfDay(data.startDate),
          note: "Initial preset fee",
          createdById: actor.id,
        },
      });

      const currentYear = await tx.academicYear.findFirst({ where: { isCurrent: true } });
      await tx.semester.createMany({
        data: slots.map((slot) => ({
          batchId: batch.id,
          semesterNumber: slot.semesterNumber,
          startDate: slot.startDate,
          endDate: slot.endDate,
          yearNumber: slot.yearNumber,
          academicYearId: slot.isFirstYear ? (currentYear?.id ?? null) : null,
        })),
      });

      return batch;
    });

    await recordAudit({
      userId: actor.id,
      action: "academic.batch_created",
      entityType: "Batch",
      entityId: created.id,
      summary: `Batch ${data.code} created with ${course.totalSemesters} semesters`,
      metadata: { tuitionFeePaise },
    });
    revalidatePath("/academic/batches");
    return ok(undefined, `Batch created with ${course.totalSemesters} semesters.`);
  });
}

export async function deleteBatchAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const id = String(formData.get("id") ?? "");
    const batch = await prisma.batch.findUnique({
      where: { id },
      include: { _count: { select: { students: true, applications: true } } },
    });
    if (!batch) return fail("Batch not found.");
    if (batch._count.students > 0 || batch._count.applications > 0) {
      return fail(
        `This batch has ${batch._count.students} student(s) and ${batch._count.applications} application(s). Mark it Discontinued instead.`,
      );
    }

    await prisma.batch.delete({ where: { id } });
    await recordAudit({
      userId: actor.id,
      action: "academic.batch_deleted",
      entityType: "Batch",
      entityId: id,
      summary: `Batch ${batch.code} deleted`,
    });
    revalidatePath("/academic/batches");
    return ok(undefined, "Batch deleted.");
  });
}

/** Record a mid-cycle fee revision with an explicit effective date (spec 2.4). */
const feeRevisionSchema = z.object({
  batchId: requiredText("Batch"),
  tuitionFeePaise: rupeeAmount("New tuition fee", { min: 0 }),
  effectiveFrom: dateInput("Effective from"),
  note: optionalText,
});

export async function reviseBatchFeeAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const parsed = feeRevisionSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { batchId, tuitionFeePaise, effectiveFrom, note } = parsed.data;
    const batch = await prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) return fail("Batch not found.");

    const effective = startOfDay(effectiveFrom);
    await prisma.batchFeeHistory.upsert({
      where: { batchId_effectiveFrom: { batchId, effectiveFrom: effective } },
      update: { tuitionFeePaise, note, createdById: actor.id },
      create: { batchId, tuitionFeePaise, effectiveFrom: effective, note, createdById: actor.id },
    });

    const lockedBefore = await prisma.student.count({
      where: { batchId, enrollmentDate: { lt: effective } },
    });

    await recordAudit({
      userId: actor.id,
      action: "academic.batch_fee_revised",
      entityType: "Batch",
      entityId: batchId,
      summary: `Batch ${batch.code} tuition revised, effective ${effective.toDateString()}`,
      metadata: { tuitionFeePaise, effectiveFrom: effective, studentsOnOldRate: lockedBefore },
    });
    revalidatePath(`/academic/batches/${batchId}`);
    return ok(
      undefined,
      `Fee revision recorded. ${lockedBefore} student(s) enrolled before this date stay on their locked rate.`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* 5.4 Semesters                                                               */
/* -------------------------------------------------------------------------- */

const semesterSchema = z
  .object({
    id: requiredText("Semester"),
    startDate: dateInput("Start date"),
    endDate: dateInput("End date"),
    examFeePaise: optionalRupeeAmount("Exam fee"),
    activityFeePaise: optionalRupeeAmount("Activity fee"),
    academicYearId: optionalText,
  })
  .refine((data) => data.endDate > data.startDate, {
    message: "End date must be after the start date.",
    path: ["endDate"],
  });

export async function saveSemesterAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const parsed = semesterSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, ...data } = parsed.data;
    const semester = await prisma.semester.findUnique({ where: { id }, include: { batch: true } });
    if (!semester) return fail("Semester not found.");

    if (data.endDate > semester.batch.completionDate) {
      return fail("A semester cannot end after the batch completion date.", {
        endDate: ["Beyond the batch completion date."],
      });
    }

    await prisma.semester.update({
      where: { id },
      data: { ...data, academicYearId: data.academicYearId ?? null },
    });

    await recordAudit({
      userId: actor.id,
      action: "academic.semester_updated",
      entityType: "Semester",
      entityId: id,
      summary: `Semester ${semester.semesterNumber} of batch ${semester.batch.code} updated`,
      metadata: { examFeePaise: data.examFeePaise, activityFeePaise: data.activityFeePaise },
    });
    revalidatePath(`/academic/batches/${semester.batchId}`);
    return ok(undefined, "Semester saved.");
  });
}
