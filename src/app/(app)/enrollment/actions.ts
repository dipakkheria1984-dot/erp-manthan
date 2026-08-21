"use server";

import { revalidatePath } from "next/cache";
import { notifyCampus } from "@/lib/campus/publisher";
import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { recordAudit, recordAuditTx } from "@/lib/audit";
import { getConfig } from "@/lib/config";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { fromDateInput, startOfDay } from "@/lib/dates";
import { registrationFeeFor, tuitionRateAt, validateInstallmentPlan, type InstallmentDraft } from "@/lib/fees";
import { refreshInstallment } from "@/lib/late-fees";
import { formatPaise, percentOf, rupeesToPaise } from "@/lib/money";
import {
  blockingItems,
  feePreview,
  findDuplicates,
  requiredRegistrationFee,
  settleProvisionalAdmission,
  statusLabel,
  submissionReadiness,
} from "@/lib/enrollment";
import { storeUpload, deleteUpload } from "@/lib/storage";
import { formatSequence, nextLfNo, nextSequenceValue, SEQ, formatStudentCode } from "@/lib/sequence";
import { queueApplicationNotification, queueWelcomeNotification } from "@/lib/notifications";
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

/* -------------------------------------------------------------------------- */
/* Step 1 — student information                                                */
/* -------------------------------------------------------------------------- */

const studentInfoSchema = z.object({
  id: optionalText,
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

export async function saveStudentInfoAction(_prev: unknown, formData: FormData): Promise<ActionResult<{ id: string }>> {
  const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CREATE);
  let newId: string | null = null;

  const result = await runAction(async () => {
    const parsed = studentInfoSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, ...data } = parsed.data;

    if (id) {
      const existing = await prisma.application.findUnique({ where: { id } });
      if (!existing) return fail("Application not found.");
      if (!isEditable(existing.status)) return fail("This application can no longer be edited.");

      await prisma.application.update({ where: { id }, data });
      await recordAudit({
        userId: actor.id,
        action: "application.updated",
        entityType: "Application",
        entityId: id,
        summary: `Student information updated for ${data.fullName}`,
      });
      revalidatePath(`/enrollment/${id}`);
      return ok({ id }, "Student information saved.");
    }

    const created = await prisma.application.create({
      data: { ...data, createdById: actor.id, status: "DRAFT" },
    });
    newId = created.id;
    await recordAudit({
      userId: actor.id,
      action: "application.created",
      entityType: "Application",
      entityId: created.id,
      summary: `Draft application created for ${data.fullName}`,
    });
    revalidatePath("/enrollment");
    return ok({ id: created.id }, "Draft created.");
  });

  // Redirect must happen outside runAction — it throws a control-flow signal.
  if (result.ok && newId) redirect(`/enrollment/${newId}/guardians`);
  return result;
}

function isEditable(status: string): boolean {
  return status === "DRAFT" || status === "SUBMITTED" || status === "UNDER_REVIEW";
}

/**
 * Guardians stay editable after enrollment. A parent's phone number is what fee
 * reminders go to and what the office rings when a family is behind, so it has
 * to be correctable for as long as the student is on the roll — unlike the
 * terms the admission was granted on, which close with the approval.
 */
function isGuardianEditable(status: string): boolean {
  return isEditable(status) || status === "ENROLLED";
}

/* -------------------------------------------------------------------------- */
/* Step 2 — guardians                                                          */
/* -------------------------------------------------------------------------- */

const guardianSchema = z.object({
  applicationId: requiredText("Application"),
  guardianId: optionalText,
  relation: z.enum(["FATHER", "MOTHER", "GUARDIAN"]),
  name: requiredText("Name", 2),
  occupation: optionalText,
  phone: optionalText,
  email: optionalText,
  isPrimary: checkboxInput,
});

export async function saveGuardianAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CREATE);
    const parsed = guardianSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { applicationId, guardianId, isPrimary, ...data } = parsed.data;
    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return fail("Application not found.");
    if (!isGuardianEditable(application.status)) return fail("This application can no longer be edited.");

    await prisma.$transaction(async (tx) => {
      if (isPrimary) {
        await tx.guardian.updateMany({ where: { applicationId }, data: { isPrimary: false } });
      }
      if (guardianId) {
        await tx.guardian.update({ where: { id: guardianId }, data: { ...data, isPrimary } });
      } else {
        await tx.guardian.create({ data: { ...data, applicationId, isPrimary } });
      }
    });

    await recordAudit({
      userId: actor.id,
      action: "application.guardian_saved",
      entityType: "Application",
      entityId: applicationId,
      summary: `Guardian ${data.name} (${parsed.data.relation.toLowerCase()}) saved`,
    });
    revalidatePath(`/enrollment/${applicationId}/guardians`);
    return ok(undefined, "Guardian saved.");
  });
}

export async function deleteGuardianAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CREATE);
    const guardianId = String(formData.get("guardianId") ?? "");
    const guardian = await prisma.guardian.findUnique({ where: { id: guardianId }, include: { application: true } });
    if (!guardian) return fail("Guardian not found.");
    if (!isGuardianEditable(guardian.application.status)) return fail("This application can no longer be edited.");

    await prisma.guardian.delete({ where: { id: guardianId } });
    await recordAudit({
      userId: actor.id,
      action: "application.guardian_removed",
      entityType: "Application",
      entityId: guardian.applicationId,
      summary: `Guardian ${guardian.name} removed`,
    });
    revalidatePath(`/enrollment/${guardian.applicationId}/guardians`);
    return ok(undefined, "Guardian removed.");
  });
}

/* -------------------------------------------------------------------------- */
/* Step 3 — course / batch selection and scholarship request                   */
/* -------------------------------------------------------------------------- */

const courseSelectionSchema = z.object({
  id: requiredText("Application"),
  academicYearId: requiredText("Academic year"),
  departmentId: requiredText("Department"),
  courseId: requiredText("Course"),
  batchId: requiredText("Batch"),
  /// Quoted either way; the form sends whichever the Registrar chose, so the
  /// other field is absent altogether. Both are optional, and no concession —
  /// 0%, or the box left empty — is a perfectly ordinary answer.
  scholarshipBasis: z.enum(["PERCENT", "AMOUNT"]).default("PERCENT"),
  requestedScholarshipPercent: optionalIntInput("Scholarship", { min: 0, max: 100 }),
  requestedScholarshipAmount: optionalRupeeAmount("Scholarship amount"),
});

export async function saveCourseSelectionAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CREATE);
    const parsed = courseSelectionSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, scholarshipBasis, requestedScholarshipPercent, requestedScholarshipAmount, ...data } = parsed.data;
    const asAmount = scholarshipBasis === "AMOUNT";
    const requestedPercent = asAmount ? 0 : (requestedScholarshipPercent ?? 0);
    const requestedPaise = asAmount ? (requestedScholarshipAmount ?? 0) : 0;
    const application = await prisma.application.findUnique({ where: { id } });
    if (!application) return fail("Application not found.");
    if (!isEditable(application.status)) return fail("This application can no longer be edited.");

    const batch = await prisma.batch.findUnique({
      where: { id: data.batchId },
      include: { course: true, _count: { select: { students: true } } },
    });
    if (!batch) return fail("Select a valid batch.", { batchId: ["Unknown batch."] });
    if (batch.courseId !== data.courseId || batch.course.departmentId !== data.departmentId) {
      return fail("The selected batch does not belong to that course and department.");
    }
    if (batch.status === "COMPLETED" || batch.status === "DISCONTINUED") {
      return fail("That batch is no longer accepting enrollments.", { batchId: ["Batch is closed."] });
    }
    // Spec 5.3 — no waitlist; enrollment is blocked at capacity.
    if (batch._count.students >= batch.totalSeats && application.batchId !== batch.id) {
      return fail("That batch is full. There is no waitlist.", { batchId: ["No seats available."] });
    }

    const config = await getConfig();
    // A flat figure is measured against the batch tuition so one threshold
    // governs both ways of quoting a concession. The threshold itself is never
    // surfaced — only the generic consequence.
    const batchRate = await tuitionRateAt(batch.id, new Date());
    const effectivePercent =
      asAmount && batchRate > 0 ? Math.round((Math.min(requestedPaise, batchRate) / batchRate) * 100) : requestedPercent;
    const needsApproval =
      effectivePercent > config.scholarshipAutoApprovePercent ||
      // No rate to measure against yet, so a flat figure cannot be auto-approved.
      (asAmount && batchRate <= 0 && requestedPaise > 0);

    await prisma.application.update({
      where: { id },
      data: {
        ...data,
        requestedScholarshipPercent: requestedPercent,
        requestedScholarshipPaise: requestedPaise,
        scholarshipNeedsApproval: needsApproval,
        approvedScholarshipPercent: needsApproval || asAmount ? null : requestedPercent,
        approvedScholarshipPaise: needsApproval || !asAmount ? null : requestedPaise,
      },
    });

    await recordAudit({
      userId: actor.id,
      action: "application.course_selected",
      entityType: "Application",
      entityId: id,
      summary:
        `Batch ${batch.code} selected with ` +
        `${asAmount ? formatPaise(requestedPaise) : `${requestedPercent}%`} scholarship requested`,
      metadata: { needsApproval },
    });
    revalidatePath(`/enrollment/${id}`);

    if (needsApproval) {
      return ok(
        undefined,
        "Saved. This discount requires Admin approval, so the application will go to Under Review on submission.",
      );
    }
    return ok(undefined, "Course selection saved.");
  });
}

/* -------------------------------------------------------------------------- */
/* Step 4 — documents                                                          */
/* -------------------------------------------------------------------------- */

export async function uploadDocumentAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CREATE);
    const applicationId = String(formData.get("applicationId") ?? "");
    const requirementCode = String(formData.get("requirementCode") ?? "");
    const file = formData.get("file");

    if (!(file instanceof File)) return fail("Choose a file to upload.", { file: ["No file selected."] });

    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return fail("Application not found.");
    if (!isEditable(application.status)) return fail("This application can no longer be edited.");

    const requirement = await prisma.documentRequirement.findUnique({ where: { code: requirementCode } });
    if (!requirement) return fail("Unknown document type.");

    const stored = await storeUpload(file, `applications/${applicationId}`);

    // Re-uploading a document replaces the previous file for that checklist item.
    const previous = await prisma.applicationDocument.findFirst({ where: { applicationId, requirementCode } });
    if (previous) {
      await deleteUpload(previous.storagePath);
      await prisma.applicationDocument.update({
        where: { id: previous.id },
        data: { ...stored, status: "PENDING", verifiedById: null, verifiedAt: null, remarks: null },
      });
    } else {
      await prisma.applicationDocument.create({
        data: { ...stored, applicationId, requirementCode, label: requirement.label },
      });
    }

    await recordAudit({
      userId: actor.id,
      action: "application.document_uploaded",
      entityType: "Application",
      entityId: applicationId,
      summary: `Document ${requirement.label} uploaded`,
    });
    revalidatePath(`/enrollment/${applicationId}/documents`);
    return ok(undefined, `${requirement.label} uploaded.`);
  });
}

const verifySchema = z.object({
  documentId: requiredText("Document"),
  decision: z.enum(["VERIFIED", "REJECTED"]),
  remarks: optionalText,
});

export async function verifyDocumentAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_VERIFY_DOCUMENTS);
    const parsed = verifySchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { documentId, decision, remarks } = parsed.data;
    if (decision === "REJECTED" && !remarks) {
      return fail("Give a reason when rejecting a document.", { remarks: ["Required when rejecting."] });
    }

    const document = await prisma.applicationDocument.findUnique({ where: { id: documentId } });
    if (!document) return fail("Document not found.");

    await prisma.applicationDocument.update({
      where: { id: documentId },
      data: { status: decision, remarks, verifiedById: actor.id, verifiedAt: new Date() },
    });

    await recordAudit({
      userId: actor.id,
      action: "application.document_verified",
      entityType: "Application",
      entityId: document.applicationId,
      summary: `Document ${document.label} marked ${decision.toLowerCase()}`,
      reason: remarks ?? null,
    });
    revalidatePath(`/enrollment/${document.applicationId}/documents`);
    return ok(undefined, `Document marked ${decision.toLowerCase()}.`);
  });
}

/* -------------------------------------------------------------------------- */
/* Step 5 — fee plan (installment amounts and due dates)                       */
/* -------------------------------------------------------------------------- */

const feePlanRowSchema = z.object({
  dueDate: z.string().trim().min(1, "Every installment needs a due date."),
  amount: z.string().trim().min(1, "Every installment needs an amount."),
});

/**
 * The Registrar fixes the installment schedule during enrollment, before any
 * money changes hands (spec 2.6). The plan covers the whole first-semester fee;
 * the registration amount collected next is the first payment against it, not a
 * deduction from it.
 */
export async function saveFeePlanAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CREATE);
    const applicationId = String(formData.get("applicationId") ?? "");

    let raw: unknown;
    try {
      raw = JSON.parse(String(formData.get("rows") ?? "[]"));
    } catch {
      return fail("The installment rows could not be read. Please re-enter them.");
    }
    const parsed = z.array(feePlanRowSchema).safeParse(raw);
    if (!parsed.success) {
      return fail("Every installment needs both an amount and a due date.");
    }

    const application = await prisma.application.findUnique({
      where: { id: applicationId },
      // The course rides along: the registration fee is set there and inherited
      // by the batch unless that batch overrides it.
      include: { batch: { include: { course: { select: { registrationFeePaise: true } } } } },
    });
    if (!application) return fail("Application not found.");
    if (!isEditable(application.status)) return fail("This application can no longer be edited.");
    if (!application.batchId || !application.batch) {
      return fail("Select the course and batch first — the fee total comes from the batch.");
    }

    const rows: InstallmentDraft[] = [];
    for (const [i, row] of parsed.data.entries()) {
      const dueDate = fromDateInput(row.dueDate);
      if (Number.isNaN(dueDate.getTime())) return fail(`Installment ${i + 1} has an invalid due date.`);
      const amountPaise = rupeesToPaise(row.amount);
      if (!Number.isFinite(amountPaise)) return fail(`Installment ${i + 1} has an invalid amount.`);
      rows.push({ seqNo: i + 1, dueDate, amountPaise });
    }

    const [config, preview] = await Promise.all([getConfig(), feePreview(application)]);
    if (!preview) return fail("This batch has no fee configured yet.");

    const problem = validateInstallmentPlan({
      rows,
      totalPayablePaise: preview.totalPayablePaise,
      completionDate: application.batch.completionDate,
      minCount: config.installmentMin,
      maxCount: config.installmentMax,
      // Installment 1 is the batch's registration fee exactly. Capped at the
      // whole fee so a heavily discounted student, whose total can fall below
      // the registration fee, still gets a schedule that adds up.
      firstInstallmentPaise: Math.min(
        preview.totalPayablePaise,
        registrationFeeFor(application.batch, config),
      ),
    });
    if (problem) return fail(problem);

    await prisma.$transaction(async (tx) => {
      await tx.applicationInstallment.deleteMany({ where: { applicationId } });
      await tx.applicationInstallment.createMany({
        data: rows.map((row) => ({
          applicationId,
          seqNo: row.seqNo,
          dueDate: row.dueDate,
          amountPaise: row.amountPaise,
        })),
      });
    });

    await recordAudit({
      userId: actor.id,
      action: "application.fee_plan_saved",
      entityType: "Application",
      entityId: applicationId,
      summary: `Fee plan set for ${application.fullName} — ${rows.length} installment(s) totalling ${formatPaise(
        preview.totalPayablePaise,
      )}`,
      metadata: { installments: rows.length, totalPayablePaise: preview.totalPayablePaise },
    });

    revalidatePath(`/enrollment/${applicationId}`);
    revalidatePath(`/enrollment/${applicationId}/fee-plan`);
    revalidatePath(`/enrollment/${applicationId}/fee`);
    return ok(undefined, `Fee plan saved — ${rows.length} installment(s).`);
  });
}

/* -------------------------------------------------------------------------- */
/* Step 6 — registration fee                                                   */
/* -------------------------------------------------------------------------- */

const registrationFeeSchema = z.object({
  applicationId: requiredText("Application"),
  amountPaise: rupeeAmount("Amount", { min: 1 }),
  paymentDate: dateInput("Payment date"),
  mode: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "CHEQUE", "OTHER"]),
  referenceNo: optionalText,
  remarks: optionalText,
});

export async function recordRegistrationFeeAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_COLLECT, PERMISSIONS.ENROLLMENT_CREATE);
    const parsed = registrationFeeSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { applicationId, amountPaise, ...rest } = parsed.data;
    const application = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { feePlan: { orderBy: { seqNo: "asc" } } },
    });
    if (!application) return fail("Application not found.");
    if (application.status === "REJECTED") return fail("This application was rejected.");

    // Nothing is collected before the schedule exists — the family is told the
    // whole commitment first (spec 2.6).
    const firstInstallment = application.feePlan[0];
    if (!firstInstallment) {
      return fail("Enter the installment plan first — step 5 — then collect the registration fee.");
    }
    const alreadyPaid = application.registrationFeePaidPaise;
    if (alreadyPaid + amountPaise > firstInstallment.amountPaise) {
      return fail(
        `The registration fee is applied to installment 1 (${formatPaise(
          firstInstallment.amountPaise,
        )}), of which ${formatPaise(alreadyPaid)} is already collected. Collect at most ${formatPaise(
          firstInstallment.amountPaise - alreadyPaid,
        )} here, or raise installment 1 in the fee plan.`,
        { amountPaise: [`Maximum ${formatPaise(firstInstallment.amountPaise - alreadyPaid)}.`] },
      );
    }

    const config = await getConfig();

    await prisma.$transaction(async (tx) => {
      const seq = await nextSequenceValue(SEQ.RECEIPT, tx);
      await tx.payment.create({
        data: {
          receiptNo: formatSequence(config.receiptPrefix, seq, config.receiptPadding),
          kind: "REGISTRATION",
          applicationId,
          amountPaise,
          collectedById: actor.id,
          ...rest,
        },
      });
      await tx.application.update({
        where: { id: applicationId },
        data: {
          registrationFeePaidPaise: { increment: amountPaise },
          // Recording a collection is the office having gone and looked, so an
          // outstanding online claim stops asking to be checked. The claim
          // itself is kept — it is what the applicant was told, and the receipt
          // now standing beside it is the record of what was actually banked.
          ...(application.claimedPaymentReference && !application.claimedPaymentSettledAt
            ? { claimedPaymentSettledAt: new Date() }
            : {}),
        },
      });
    });

    await recordAudit({
      userId: actor.id,
      action: "application.registration_fee_recorded",
      entityType: "Application",
      entityId: applicationId,
      summary: `Registration fee recorded for ${application.fullName}`,
      metadata: { amountPaise, mode: rest.mode },
    });

    // Clearing the registration fee ends a provisional admission on its own.
    const { cleared } = await settleProvisionalAdmission(applicationId, actor.id);

    revalidatePath(`/enrollment/${applicationId}`);
    revalidatePath(`/enrollment/${applicationId}/fee`);
    return ok(
      undefined,
      cleared
        ? "Registration fee recorded. The registration fee is now cleared, so the provisional admission has been confirmed."
        : "Registration fee recorded.",
    );
  });
}

/** Provisional admission ahead of the full registration fee (spec 1.4). */
export async function toggleProvisionalAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_APPROVE);
    const applicationId = String(formData.get("applicationId") ?? "");
    const reason = String(formData.get("reason") ?? "");
    const parsedReason = reasonInput.safeParse(reason);
    if (!parsedReason.success) {
      return fail("A reason is required.", { reason: [parsedReason.error.issues[0].message] });
    }

    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return fail("Application not found.");

    await prisma.application.update({
      where: { id: applicationId },
      data: { isProvisional: !application.isProvisional },
    });

    await recordAudit({
      userId: actor.id,
      action: "application.provisional_toggled",
      entityType: "Application",
      entityId: applicationId,
      summary: `Provisional admission ${application.isProvisional ? "withdrawn" : "granted"} for ${application.fullName}`,
      reason: parsedReason.data,
    });
    revalidatePath(`/enrollment/${applicationId}`);
    return ok(undefined, application.isProvisional ? "Provisional admission withdrawn." : "Provisional admission granted.");
  });
}

/* -------------------------------------------------------------------------- */
/* Discarding a draft                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Throws away a draft that is never going anywhere — a mis-keyed start, a
 * duplicate, or an online form somebody abandoned half-filled.
 *
 * Drafts only. Once an application is submitted it has an application number
 * quoted to the applicant, and once it is approved there is a student; those
 * are rejected or handled through status, never deleted.
 *
 * The row goes for real, taking its guardians, documents, fee plan and
 * notifications with it — the schema already cascades those, and a draft has
 * nothing worth keeping. Two things it cannot take: a payment or a student,
 * neither of which cascades, so the database would refuse anyway. They are
 * checked here so the answer is a sentence rather than a constraint violation,
 * and because money on record means this is not a draft to throw away at all.
 *
 * The audit row survives: it holds the id as plain text, not a foreign key, so
 * the trail of what was discarded and why outlives the record.
 */
export async function discardApplicationAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  let discarded = false;

  const result = await runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CREATE);
    const applicationId = String(formData.get("applicationId") ?? "");
    const parsedReason = reasonInput.safeParse(String(formData.get("reason") ?? ""));
    if (!parsedReason.success) {
      return fail("A reason is required.", { reason: [parsedReason.error.issues[0].message] });
    }

    const application = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        documents: true,
        student: { select: { studentCode: true } },
        _count: { select: { payments: true, guardians: true, documents: true } },
      },
    });
    if (!application) return fail("Application not found.");

    if (application.status !== "DRAFT") {
      return fail(
        `Only a draft can be discarded — this one is ${statusLabel(application.status).toLowerCase()}. ` +
          `Reject it instead, which keeps the record and the reason.`,
      );
    }
    if (application.student) {
      return fail(`${application.student.studentCode} is enrolled against this application. It cannot be discarded.`);
    }
    if (application._count.payments > 0) {
      return fail(
        `${application._count.payments} payment(s) are recorded against this application. Cancel the receipt(s) ` +
          `first if they were a mistake — money on record is never thrown away with the draft.`,
      );
    }

    // Written before the row goes, so a failure here leaves an audit row for an
    // application that still exists rather than a deletion with no trace.
    await recordAudit({
      userId: actor.id,
      action: "application.discarded",
      entityType: "Application",
      entityId: applicationId,
      summary: `Draft application for ${application.fullName} discarded`,
      reason: parsedReason.data,
      metadata: {
        source: application.source,
        guardians: application._count.guardians,
        documents: application._count.documents,
        applicantSubmittedAt: application.applicantSubmittedAt?.toISOString() ?? null,
        claimedPaymentReference: application.claimedPaymentReference,
      },
    });

    await prisma.application.delete({ where: { id: applicationId } });

    // Only after the row is gone. Deleting the files first would strand the
    // uploads if the delete then failed, leaving rows pointing at nothing.
    for (const document of application.documents) {
      await deleteUpload(document.storagePath).catch((error) => {
        console.error("[enrollment] could not remove a discarded application's upload", error);
      });
    }

    revalidatePath("/enrollment");
    discarded = true;
    return ok(undefined, "Draft discarded.");
  });

  if (result.ok && discarded) redirect("/enrollment");
  return result;
}

/* -------------------------------------------------------------------------- */
/* Step 6 — submission                                                         */
/* -------------------------------------------------------------------------- */

export async function submitApplicationAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_CREATE);
    const applicationId = String(formData.get("applicationId") ?? "");

    const application = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { guardians: true, documents: true, feePlan: { orderBy: { seqNo: "asc" } } },
    });
    if (!application) return fail("Application not found.");
    if (application.status !== "DRAFT") return fail("This application has already been submitted.");

    const config = await getConfig();
    const readiness = await submissionReadiness(application, await requiredRegistrationFee(application));
    const blocking = blockingItems(readiness);
    if (blocking.length > 0) {
      return fail(`Cannot submit yet — ${blocking.map((item) => item.label.toLowerCase()).join(", ")} still incomplete.`);
    }

    const duplicates = await findDuplicates(application);
    // A scholarship above the hidden threshold routes straight to Under Review.
    const nextStatus = application.scholarshipNeedsApproval ? "UNDER_REVIEW" : "SUBMITTED";

    const updated = await prisma.$transaction(async (tx) => {
      const seq = await nextSequenceValue(SEQ.APPLICATION, tx);
      const applicationNo = formatSequence(config.applicationPrefix, seq, config.applicationPadding);
      const result = await tx.application.update({
        where: { id: applicationId },
        data: {
          applicationNo,
          status: nextStatus,
          submittedAt: new Date(),
          duplicateFlags: duplicates.length > 0 ? (duplicates as never) : undefined,
        },
      });
      await recordAuditTx(tx, {
        userId: actor.id,
        action: "application.submitted",
        entityType: "Application",
        entityId: applicationId,
        summary: `Application ${applicationNo} submitted for ${application.fullName}`,
        metadata: { duplicates: duplicates.length, status: nextStatus },
      });
      return result;
    });

    await queueApplicationNotification(updated.id, "APPLICATION_SUBMITTED");

    revalidatePath("/enrollment");
    revalidatePath(`/enrollment/${applicationId}`);
    return ok(
      undefined,
      duplicates.length > 0
        ? `Submitted as ${updated.applicationNo}. ${duplicates.length} possible duplicate(s) flagged for review.`
        : `Submitted as ${updated.applicationNo}.`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Step 7/8 — Admin review and decision                                        */
/* -------------------------------------------------------------------------- */

export async function startReviewAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_APPROVE);
    const applicationId = String(formData.get("applicationId") ?? "");
    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return fail("Application not found.");
    if (application.status !== "SUBMITTED") return fail("Only submitted applications can move to review.");

    await prisma.application.update({ where: { id: applicationId }, data: { status: "UNDER_REVIEW" } });
    await recordAudit({
      userId: actor.id,
      action: "application.review_started",
      entityType: "Application",
      entityId: applicationId,
      summary: `Application ${application.applicationNo} moved to Under Review`,
    });
    await queueApplicationNotification(applicationId, "APPLICATION_STATUS_CHANGE");
    revalidatePath(`/enrollment/${applicationId}`);
    return ok(undefined, "Moved to Under Review.");
  });
}

const approvalSchema = z.object({
  applicationId: requiredText("Application"),
  reason: reasonInput,
  lfNo: optionalText,
  /// The Admin may confirm the concession either way, whichever was requested,
  /// so — as on the course step — only one of the two fields is ever posted.
  /// Approving no scholarship at all is allowed: 0, or blank.
  scholarshipBasis: z.enum(["PERCENT", "AMOUNT"]).default("PERCENT"),
  approvedScholarshipPercent: optionalIntInput("Approved scholarship", { min: 0, max: 100 }),
  approvedScholarshipAmount: optionalRupeeAmount("Approved scholarship amount"),
});

/**
 * Approve an application: assign the LF No., derive the Student ID, create the
 * Student record, lock the tuition rate and turn the Registrar's fee plan into
 * the student's real installment schedule.
 */
export async function approveApplicationAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_APPROVE);
    const parsed = approvalSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { applicationId, reason, scholarshipBasis } = parsed.data;
    const approvedAsAmount = scholarshipBasis === "AMOUNT";
    const approvedScholarshipPercent = approvedAsAmount ? 0 : (parsed.data.approvedScholarshipPercent ?? 0);
    const approvedScholarshipPaise = approvedAsAmount ? (parsed.data.approvedScholarshipAmount ?? 0) : 0;
    const config = await getConfig();

    const application = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        batch: { include: { course: true, _count: { select: { students: true } } } },
        feePlan: { orderBy: { seqNo: "asc" } },
        payments: { where: { kind: "REGISTRATION", status: "ACTIVE" } },
      },
    });
    if (!application) return fail("Application not found.");
    if (application.status !== "SUBMITTED" && application.status !== "UNDER_REVIEW") {
      return fail("Only submitted or under-review applications can be approved.");
    }
    if (!application.batchId || !application.batch || !application.courseId || !application.departmentId) {
      return fail("The application has no batch selected.");
    }
    if (application.batch._count.students >= application.batch.totalSeats) {
      return fail("That batch is now full. There is no waitlist.");
    }
    if (application.feePlan.length === 0) {
      return fail("This application has no fee plan. Enter the installments on the Fee plan tab before approving.");
    }

    const firstSemester = await prisma.semester.findFirst({
      where: { batchId: application.batchId, semesterNumber: 1 },
    });
    if (!firstSemester) return fail("The batch has no semester 1 configured.");

    const enrollmentDate = startOfDay(new Date());

    // Tuition is locked to the batch fee version effective on the enrollment date.
    const lockedRate = await tuitionRateAt(application.batchId, enrollmentDate);
    // A flat concession can never exceed the tuition it is discounting.
    const scholarshipAmount = approvedAsAmount
      ? Math.min(approvedScholarshipPaise, lockedRate)
      : percentOf(lockedRate, approvedScholarshipPercent);
    const tuitionComponent = lockedRate - scholarshipAmount;
    // The registration fee is part of this total, never deducted from it.
    const totalPayable = tuitionComponent + firstSemester.examFeePaise + firstSemester.activityFeePaise;

    const plan: InstallmentDraft[] = application.feePlan.map((row) => ({
      seqNo: row.seqNo,
      dueDate: row.dueDate,
      amountPaise: row.amountPaise,
    }));

    const registrationPaid = application.payments.reduce((sum, payment) => sum + payment.amountPaise, 0);
    // What this batch asks a new admission to register with. Capped at the
    // whole fee, so a student whose scholarship takes the total below the
    // registration fee still gets a schedule that adds up — and clearing that
    // single installment confirms them just the same.
    const requiredRegistration = Math.min(totalPayable, registrationFeeFor(application.batch, config));
    const problem = validateInstallmentPlan({
      rows: plan,
      totalPayablePaise: totalPayable,
      completionDate: application.batch.completionDate,
      minCount: config.installmentMin,
      maxCount: config.installmentMax,
      firstInstallmentPaise: requiredRegistration,
      minFirstInstallmentPaise: registrationPaid,
    });
    if (problem) {
      return fail(
        `${problem} Update the fee plan (step 5) — approving a ${
          approvedAsAmount ? formatPaise(scholarshipAmount) : `${approvedScholarshipPercent}%`
        } scholarship makes the fee ${formatPaise(totalPayable)}.`,
      );
    }

    const student = await prisma.$transaction(async (tx) => {
      const explicitLf = parsed.data.lfNo ? Number.parseInt(parsed.data.lfNo, 10) : null;
      if (explicitLf !== null && !Number.isFinite(explicitLf)) {
        throw new Error("LF No. must be a number.");
      }
      if (explicitLf !== null) {
        const clash = await tx.student.findUnique({ where: { lfNo: explicitLf } });
        if (clash) throw new Error(`LF No. ${explicitLf} is already assigned to ${clash.studentCode}.`);
        // The number is unique on the application too, and is held from the
        // moment one is approved — without this the Admin would meet the raw
        // constraint error rather than a sentence explaining it.
        const held = await tx.application.findUnique({ where: { lfNo: explicitLf }, select: { id: true } });
        if (held) throw new Error(`LF No. ${explicitLf} is already in use.`);
      }
      const lfNo = explicitLf ?? (await nextLfNo(tx));
      const studentCode = formatStudentCode(config.studentIdPrefix, lfNo, config.lfNoLength);

      const createdStudent = await tx.student.create({
        data: {
          studentCode,
          lfNo,
          applicationId,
          fullName: application.fullName,
          dob: application.dob,
          gender: application.gender,
          photoPath: application.photoPath,
          bloodGroup: application.bloodGroup,
          addressLine1: application.addressLine1,
          addressLine2: application.addressLine2,
          city: application.city,
          state: application.state,
          pincode: application.pincode,
          phone: application.phone,
          email: application.email,
          nationalId: application.nationalId,
          departmentId: application.departmentId!,
          courseId: application.courseId!,
          batchId: application.batchId!,
          currentSemesterId: firstSemester.id,
          enrollmentDate,
          status: "ACTIVE",
        },
      });

      const feeAssignment = await tx.feeAssignment.create({
        data: {
          studentId: createdStudent.id,
          semesterId: firstSemester.id,
          academicYearId: firstSemester.academicYearId ?? application.academicYearId,
          yearNumber: 1,
          lockedTuitionRatePaise: lockedRate,
          tuitionComponentPaise: tuitionComponent,
          scholarshipPercent: approvedScholarshipPercent,
          scholarshipAmountPaise: scholarshipAmount,
          examFeePaise: firstSemester.examFeePaise,
          activityFeePaise: firstSemester.activityFeePaise,
          totalPayablePaise: totalPayable,
          createdById: actor.id,
        },
      });

      await tx.installment.createMany({
        data: plan.map((item) => ({ ...item, feeAssignmentId: feeAssignment.id })),
      });

      await tx.application.update({
        where: { id: applicationId },
        data: {
          status: "ENROLLED",
          approvedScholarshipPercent,
          approvedScholarshipPaise: approvedAsAmount ? scholarshipAmount : null,
          scholarshipNeedsApproval: false,
          reviewedAt: new Date(),
          reviewedById: actor.id,
          decisionReason: reason,
          lfNo,
          studentCode,
          // A new admission is provisional until the batch's registration fee
          // is cleared, and confirmed the moment it is. The Registrar no longer
          // has to remember to set this; the manual toggle stays for the
          // exceptions it was built for. `settleProvisionalAdmission` is the
          // other half — it lifts this on its own when the money lands.
          isProvisional: registrationPaid < requiredRegistration,
        },
      });

      // Registration-fee receipts follow the student, and — because that money
      // is part of the total fee — they settle the first installment rather
      // than reducing what was billed.
      const firstInstallment = await tx.installment.findFirstOrThrow({
        where: { feeAssignmentId: feeAssignment.id },
        orderBy: { seqNo: "asc" },
      });
      await tx.payment.updateMany({
        where: { applicationId, kind: "REGISTRATION" },
        data: { studentId: createdStudent.id },
      });
      await tx.payment.updateMany({
        where: { applicationId, kind: "REGISTRATION", status: "ACTIVE" },
        data: { installmentId: firstInstallment.id },
      });
      await refreshInstallment(firstInstallment.id, tx, enrollmentDate);

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "application.approved",
        entityType: "Application",
        entityId: applicationId,
        summary: `Application ${application.applicationNo} approved — ${studentCode} enrolled in ${application.batch!.code}`,
        reason,
        metadata: {
          lfNo,
          studentCode,
          lockedTuitionRatePaise: lockedRate,
          approvedScholarshipPercent,
          approvedScholarshipAmountPaise: scholarshipAmount,
          totalPayablePaise: totalPayable,
          registrationAppliedPaise: registrationPaid,
          installmentCount: plan.length,
        },
      });

      return createdStudent;
    });

    await queueWelcomeNotification(student.id);
    await notifyCampus(student.id, "ALL", "enrollment.approved");

    revalidatePath("/enrollment");
    revalidatePath(`/enrollment/${applicationId}`);
    revalidatePath("/students");
    return ok(undefined, `Approved. ${student.studentCode} is now enrolled and active.`);
  });
}

export async function rejectApplicationAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ENROLLMENT_APPROVE);
    const applicationId = String(formData.get("applicationId") ?? "");
    const parsedReason = reasonInput.safeParse(String(formData.get("reason") ?? ""));
    if (!parsedReason.success) {
      return fail("A rejection reason is required.", { reason: [parsedReason.error.issues[0].message] });
    }

    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return fail("Application not found.");
    if (application.status === "ENROLLED") return fail("An enrolled student cannot be rejected here.");

    await prisma.application.update({
      where: { id: applicationId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedById: actor.id,
        decisionReason: parsedReason.data,
      },
    });

    await recordAudit({
      userId: actor.id,
      action: "application.rejected",
      entityType: "Application",
      entityId: applicationId,
      summary: `Application ${application.applicationNo ?? "(draft)"} rejected`,
      reason: parsedReason.data,
    });
    await queueApplicationNotification(applicationId, "APPLICATION_STATUS_CHANGE");

    revalidatePath("/enrollment");
    revalidatePath(`/enrollment/${applicationId}`);
    return ok(undefined, "Application rejected and the applicant has been notified.");
  });
}
