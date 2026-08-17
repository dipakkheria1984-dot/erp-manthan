"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { getConfig } from "@/lib/config";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { storeUpload, deleteUpload } from "@/lib/storage";
import {
  issuePortalToken,
  notifyOfficeOfApplication,
  requireEditableApplication,
  sendApplicantLink,
  withinRateLimit,
} from "@/lib/applicant-portal";
import {
  checkboxInput,
  fieldErrorsOf,
  formObject,
  optionalDateInput,
  optionalText,
  requiredText,
} from "@/lib/validation";

/**
 * Server actions behind the public admission form.
 *
 * Everything here runs unauthenticated, so each action re-resolves the token
 * through `requireEditableApplication` rather than trusting anything the form
 * posts. The token is the only thing that says which application may be
 * written to; an id in the body would let anyone edit any application.
 *
 * None of these touch the batch, the fee plan, the registration fee or the
 * application's status. That is the whole point of the split — the applicant
 * describes themselves, the office decides the money.
 */

const HOUR_MS = 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Starting an application                                                     */
/* -------------------------------------------------------------------------- */

const startSchema = z.object({
  fullName: requiredText("Full name", 2),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]),
  phone: optionalText,
  email: optionalText,
});

export async function startApplicationAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  let token: string | null = null;

  const result = await runAction(async () => {
    const config = await getConfig();
    if (!config.onlineAdmissionsEnabled) return fail("Online admissions are closed.");

    const parsed = startSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { fullName, gender, phone, email } = parsed.data;
    // Without one of these the applicant can never be sent their link, and the
    // office has no way to reach them about the fees.
    if (!phone && !email) {
      return fail("Enter a phone number or an email address so we can send you your form link.", {
        email: ["Give at least one way to contact you."],
      });
    }

    if (!(await withinRateLimit("apply:start", config.onlineAdmissionsPerHour, HOUR_MS))) {
      return fail("Too many applications started from this connection. Please try again later.");
    }

    const issued = await issuePortalToken();
    const application = await prisma.application.create({
      data: {
        fullName,
        gender,
        phone: phone || null,
        email: email || null,
        status: "DRAFT",
        source: "ONLINE",
        portalTokenHash: issued.hash,
        portalTokenExpiresAt: issued.expiresAt,
      },
    });

    await recordAudit({
      userId: null,
      action: "application.online_started",
      entityType: "Application",
      entityId: application.id,
      summary: `Online admission form started by ${fullName}`,
    });

    // A failure here must not lose the application — the applicant is about to
    // be shown the same link on screen, and can ask the office to resend it.
    await sendApplicantLink(application, issued.token).catch((error) => {
      console.error("[apply] could not send the applicant their link", error);
    });

    token = issued.token;
    return ok(undefined, "Application started.");
  });

  // Redirect must happen outside runAction — it throws a control-flow signal.
  if (result.ok && token) redirect(`/apply/${token}/student`);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Step 1 — the applicant's own details                                        */
/* -------------------------------------------------------------------------- */

const studentSchema = z.object({
  token: requiredText("Token"),
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

export async function savePortalStudentInfoAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const parsed = studentSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { token, ...data } = parsed.data;
    const application = await requireEditableApplication(token);

    await prisma.application.update({ where: { id: application.id }, data });
    revalidatePath(`/apply/${token}/student`);
    return ok(undefined, "Your details have been saved.");
  });
}

/* -------------------------------------------------------------------------- */
/* Step 2 — guardians                                                          */
/* -------------------------------------------------------------------------- */

const guardianSchema = z.object({
  token: requiredText("Token"),
  guardianId: optionalText,
  relation: z.enum(["FATHER", "MOTHER", "GUARDIAN"]),
  name: requiredText("Name", 2),
  occupation: optionalText,
  phone: optionalText,
  email: optionalText,
  isPrimary: checkboxInput,
});

export async function savePortalGuardianAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const parsed = guardianSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { token, guardianId, ...data } = parsed.data;
    const application = await requireEditableApplication(token);

    // Exactly one primary, so fee reminders have an unambiguous contact.
    if (data.isPrimary) {
      await prisma.guardian.updateMany({
        where: { applicationId: application.id },
        data: { isPrimary: false },
      });
    }

    if (guardianId) {
      const existing = await prisma.guardian.findFirst({
        where: { id: guardianId, applicationId: application.id },
      });
      if (!existing) return fail("That guardian is not on this application.");
      await prisma.guardian.update({ where: { id: guardianId }, data });
    } else {
      const count = await prisma.guardian.count({ where: { applicationId: application.id } });
      if (count >= 6) return fail("You can add up to six guardians.");
      await prisma.guardian.create({
        data: { ...data, applicationId: application.id, isPrimary: data.isPrimary || count === 0 },
      });
    }

    revalidatePath(`/apply/${token}/guardians`);
    return ok(undefined, "Guardian saved.");
  });
}

export async function deletePortalGuardianAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const token = String(formData.get("token") ?? "");
    const guardianId = String(formData.get("guardianId") ?? "");
    const application = await requireEditableApplication(token);

    const guardian = await prisma.guardian.findFirst({
      where: { id: guardianId, applicationId: application.id },
    });
    if (!guardian) return fail("That guardian is not on this application.");

    await prisma.guardian.delete({ where: { id: guardianId } });

    // Never leave the remaining guardians without a primary.
    if (guardian.isPrimary) {
      const next = await prisma.guardian.findFirst({
        where: { applicationId: application.id },
        orderBy: { createdAt: "asc" },
      });
      if (next) await prisma.guardian.update({ where: { id: next.id }, data: { isPrimary: true } });
    }

    revalidatePath(`/apply/${token}/guardians`);
    return ok(undefined, "Guardian removed.");
  });
}

/* -------------------------------------------------------------------------- */
/* Step 3 — department and course                                              */
/* -------------------------------------------------------------------------- */

const courseSchema = z.object({
  token: requiredText("Token"),
  departmentId: requiredText("Department"),
  courseId: requiredText("Course"),
});

/**
 * The applicant picks a department and a course, and nothing else.
 *
 * The batch is the office's: it carries the seat count, the tuition rate and
 * the academic year, and choosing it wrongly is not a mistake an applicant can
 * be expected to avoid. The scholarship request is theirs to ask for in person,
 * not to enter into a form that would auto-approve it.
 */
export async function savePortalCourseAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const parsed = courseSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { token, departmentId, courseId } = parsed.data;
    const application = await requireEditableApplication(token);

    const course = await prisma.course.findUnique({ where: { id: courseId }, include: { department: true } });
    if (!course || course.status !== "ACTIVE") {
      return fail("Choose a course that is currently open.", { courseId: ["Unknown course."] });
    }
    if (course.departmentId !== departmentId || course.department.status !== "ACTIVE") {
      return fail("That course does not belong to the selected department.", {
        courseId: ["Course and department do not match."],
      });
    }

    await prisma.application.update({
      where: { id: application.id },
      // The batch is deliberately left alone; the Registrar sets it.
      data: { departmentId, courseId },
    });

    revalidatePath(`/apply/${token}/course`);
    return ok(undefined, "Course choice saved.");
  });
}

/* -------------------------------------------------------------------------- */
/* Step 4 — documents                                                          */
/* -------------------------------------------------------------------------- */

export async function uploadPortalDocumentAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const token = String(formData.get("token") ?? "");
    const requirementCode = String(formData.get("requirementCode") ?? "");
    const file = formData.get("file");
    if (!(file instanceof File)) return fail("Choose a file to upload.", { file: ["No file selected."] });

    const application = await requireEditableApplication(token);

    // Metered separately from starting an application: one applicant replacing
    // a document a few times is normal, a script filling the bucket is not.
    if (!(await withinRateLimit("apply:upload", 40, HOUR_MS))) {
      return fail("Too many uploads from this connection. Please try again later.");
    }

    const requirement = await prisma.documentRequirement.findUnique({ where: { code: requirementCode } });
    if (!requirement || !requirement.isActive) return fail("Unknown document type.");

    // `storeUpload` validates type and size, and throws a ValidationError that
    // `runAction` turns into a message the applicant can act on.
    const stored = await storeUpload(file, `applications/${application.id}`);

    const previous = await prisma.applicationDocument.findFirst({
      where: { applicationId: application.id, requirementCode },
    });
    if (previous) {
      await deleteUpload(previous.storagePath);
      await prisma.applicationDocument.update({
        where: { id: previous.id },
        // Replacing a file drops any verification it had — staff check the new one.
        data: { ...stored, status: "PENDING", verifiedById: null, verifiedAt: null, remarks: null },
      });
    } else {
      await prisma.applicationDocument.create({
        data: { ...stored, applicationId: application.id, requirementCode, label: requirement.label },
      });
    }

    revalidatePath(`/apply/${token}/documents`);
    return ok(undefined, `${requirement.label} uploaded.`);
  });
}

/* -------------------------------------------------------------------------- */
/* Finishing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The applicant's last act.
 *
 * The record stays DRAFT — `submitApplicationAction` is the office's, and gates
 * on the fee plan and registration fee that only they can set. What changes
 * here is that the applicant is done: the form closes, the link stops working,
 * and the row appears on the Registrar's "awaiting fee assignment" list.
 */
export async function finishPortalApplicationAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  let finished = false;

  const result = await runAction(async () => {
    const token = String(formData.get("token") ?? "");
    const application = await requireEditableApplication(token);

    const [guardianCount, documents, requirements] = await Promise.all([
      prisma.guardian.count({ where: { applicationId: application.id } }),
      prisma.applicationDocument.findMany({
        where: { applicationId: application.id },
        select: { requirementCode: true },
      }),
      prisma.documentRequirement.findMany({ where: { isActive: true, isRequired: true } }),
    ]);

    const missing: string[] = [];
    if (!application.courseId) missing.push("your department and course");
    if (guardianCount === 0) missing.push("at least one parent or guardian");

    const uploaded = new Set(documents.map((d) => d.requirementCode));
    const missingDocs = requirements.filter((r) => !uploaded.has(r.code));
    if (missingDocs.length > 0) missing.push(missingDocs.map((r) => r.label).join(", "));

    if (missing.length > 0) return fail(`Still needed before you can finish: ${missing.join("; ")}.`);

    await prisma.application.update({
      where: { id: application.id },
      data: {
        applicantSubmittedAt: new Date(),
        // The link has done its job. Clearing it closes the form to anyone who
        // has the URL — including whoever it may have been forwarded to.
        portalTokenHash: null,
        portalTokenExpiresAt: null,
      },
    });

    await recordAudit({
      userId: null,
      action: "application.online_completed",
      entityType: "Application",
      entityId: application.id,
      summary: `${application.fullName} completed the online admission form`,
      metadata: { guardians: guardianCount, documents: documents.length },
    });

    await notifyOfficeOfApplication(application).catch((error) => {
      console.error("[apply] could not notify the office", error);
    });

    // Everything above is committed and the link is already spent, so nothing
    // from here may turn this into a failure: an applicant told "something went
    // wrong" would try again and find their own link dead. Refreshing the
    // staff list is a cache hint, and the office's own page load will do it
    // anyway if this does not.
    try {
      revalidatePath("/enrollment");
    } catch (error) {
      console.error("[apply] could not refresh the enrollment list", error);
    }

    finished = true;
    return ok(undefined, "Your form has been sent to the admissions office.");
  });

  if (result.ok && finished) redirect("/apply/done");
  return result;
}
