import "server-only";
import { prisma, type Db } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { recordAudit, recordAuditTx } from "@/lib/audit";
import { tuitionRateAt } from "@/lib/fees";
import { refreshInstallment } from "@/lib/late-fees";
import { formatPaise, percentOf } from "@/lib/money";
import type {
  Application,
  ApplicationDocument,
  ApplicationInstallment,
  Guardian,
} from "@/generated/prisma/client";

/**
 * Submission readiness (spec 1.4 / 1.5). Kept separate from the actions so the
 * wizard can show the same checklist the submit action enforces.
 */

export type ApplicationWithRelations = Application & {
  guardians: Guardian[];
  documents: ApplicationDocument[];
  feePlan: ApplicationInstallment[];
};

/** Sum of a drafted installment plan. */
export function planTotalPaise(plan: Pick<ApplicationInstallment, "amountPaise">[]): number {
  return plan.reduce((sum, row) => sum + row.amountPaise, 0);
}

export type ReadinessItem = {
  key: string;
  label: string;
  done: boolean;
  detail?: string;
  href?: string;
  /** Shown in the checklist for follow-up, but never blocks submission. */
  optional?: boolean;
};

/** The items that actually gate Draft → Submitted. */
export function blockingItems(readiness: ReadinessItem[]): ReadinessItem[] {
  return readiness.filter((item) => !item.done && !item.optional);
}

export async function submissionReadiness(
  application: ApplicationWithRelations,
  minRegistrationFeePaise: number,
  db: Db = prisma,
): Promise<ReadinessItem[]> {
  const requiredDocs = await db.documentRequirement.findMany({
    where: { isActive: true, isRequired: true },
    orderBy: { sortOrder: "asc" },
  });
  const uploadedCodes = new Set(application.documents.map((d) => d.requirementCode));
  const missingDocs = requiredDocs.filter((doc) => !uploadedCodes.has(doc.code));

  const preview = await feePreview(application, db);
  const planTotal = planTotalPaise(application.feePlan);
  const planMatches = preview !== null && application.feePlan.length > 0 && planTotal === preview.totalPayablePaise;

  const base = `/enrollment/${application.id}`;

  return [
    {
      key: "student",
      label: "Student information",
      // Date of birth is captured when available but never gates submission.
      done: Boolean(application.fullName && application.gender),
      detail: "Full name and gender are needed. Date of birth is optional and can be added later.",
      href: `${base}/edit`,
    },
    {
      key: "contact",
      label: "Contact details",
      done: Boolean(application.phone || application.email),
      detail: "At least a phone number or an email address is needed for reminders.",
      href: `${base}/edit`,
    },
    {
      key: "guardians",
      label: "Parent / guardian",
      done: application.guardians.length > 0,
      detail: "At least one of father, mother or guardian is compulsory.",
      href: `${base}/guardians`,
    },
    {
      key: "course",
      label: "Course & batch selection",
      done: Boolean(application.departmentId && application.courseId && application.batchId && application.academicYearId),
      href: `${base}/course`,
    },
    {
      key: "feePlan",
      label: "Fee plan & installments",
      // The Registrar fixes the schedule before any money is collected, so the
      // family knows the whole first-semester commitment up front (spec 2.6).
      done: planMatches,
      detail: !preview
        ? "Select the course and batch first — the fee total comes from the batch."
        : application.feePlan.length === 0
          ? "Enter the installment amounts and due dates before collecting any fee."
          : `The plan totals ${formatPaise(planTotal)} but this batch's fee is ${formatPaise(
              preview.totalPayablePaise,
            )}. Adjust the installments so they match.`,
      href: `${base}/fee-plan`,
    },
    {
      key: "documents",
      label: "Documents",
      // Uploads are collected when the family has them; an application can be
      // submitted and approved with none on file.
      done: missingDocs.length === 0,
      optional: true,
      detail:
        missingDocs.length > 0
          ? `Not uploaded yet: ${missingDocs.map((d) => d.label).join(", ")}. These can follow after enrollment.`
          : undefined,
      href: `${base}/documents`,
    },
    {
      key: "registration",
      label: "Registration fee",
      done: application.registrationFeePaidPaise >= minRegistrationFeePaise,
      detail:
        "Partial or full payment is accepted, above the institute's minimum. It counts towards the first installment — it is not an extra charge.",
      href: `${base}/fee`,
    },
  ];
}

/**
 * Fee that approval would lock in. Shared by the fee-plan step, the overview and
 * the review tab so everyone works from the same numbers.
 *
 * The registration fee is *part of* this total, not a deduction from it: it is
 * the first money received against the first installment.
 */

export type FeePreview = {
  lockedRatePaise: number;
  scholarshipPercent: number;
  scholarshipAmountPaise: number;
  examFeePaise: number;
  activityFeePaise: number;
  /** Whole first-semester fee — what the installment plan must add up to. */
  totalPayablePaise: number;
  /** Registration fee already collected against that total. */
  registrationPaidPaise: number;
  /** Still to be collected after the registration fee. */
  outstandingPaise: number;
};

/**
 * A scholarship is quoted either as a percentage of the batch tuition or as a
 * flat figure; whichever was used, this resolves it against a known rate. The
 * approved figure wins over the requested one once an Admin has set it.
 */
export function resolveScholarship(
  application: Pick<
    Application,
    | "requestedScholarshipPercent"
    | "requestedScholarshipPaise"
    | "approvedScholarshipPercent"
    | "approvedScholarshipPaise"
  >,
  lockedRatePaise: number,
): { percent: number; amountPaise: number; isAmount: boolean } {
  const decided = application.approvedScholarshipPercent !== null || application.approvedScholarshipPaise !== null;
  const percent = decided ? (application.approvedScholarshipPercent ?? 0) : application.requestedScholarshipPercent;
  const paise = decided ? (application.approvedScholarshipPaise ?? 0) : application.requestedScholarshipPaise;

  // A flat figure can never exceed the tuition it is discounting.
  if (paise > 0) return { percent: 0, amountPaise: Math.min(paise, lockedRatePaise), isAmount: true };
  return { percent, amountPaise: percentOf(lockedRatePaise, percent), isAmount: false };
}

/** "12% (−₹14,400.00)", "−₹15,000.00" for a flat figure, or "None". */
export function scholarshipLabel(percent: number, amountPaise: number): string {
  if (amountPaise <= 0) return "None";
  return percent > 0 ? `${percent}% (−${formatPaise(amountPaise)})` : `−${formatPaise(amountPaise)} (fixed amount)`;
}

export async function feePreview(
  application: Pick<
    Application,
    | "batchId"
    | "requestedScholarshipPercent"
    | "requestedScholarshipPaise"
    | "approvedScholarshipPercent"
    | "approvedScholarshipPaise"
    | "registrationFeePaidPaise"
  >,
  db: Db = prisma,
): Promise<FeePreview | null> {
  if (!application.batchId) return null;

  const [lockedRatePaise, firstSemester] = await Promise.all([
    tuitionRateAt(application.batchId, new Date(), db),
    db.semester.findFirst({ where: { batchId: application.batchId, semesterNumber: 1 } }),
  ]);

  const { percent: scholarshipPercent, amountPaise: scholarshipAmountPaise } = resolveScholarship(
    application,
    lockedRatePaise,
  );
  const examFeePaise = firstSemester?.examFeePaise ?? 0;
  const activityFeePaise = firstSemester?.activityFeePaise ?? 0;
  const totalPayablePaise = lockedRatePaise - scholarshipAmountPaise + examFeePaise + activityFeePaise;

  return {
    lockedRatePaise,
    scholarshipPercent,
    scholarshipAmountPaise,
    examFeePaise,
    activityFeePaise,
    totalPayablePaise,
    registrationPaidPaise: application.registrationFeePaidPaise,
    outstandingPaise: Math.max(0, totalPayablePaise - application.registrationFeePaidPaise),
  };
}

/**
 * Provisional admission ends by itself once the money that made it provisional
 * arrives (spec 1.4). Called after every registration-fee collection and every
 * installment payment.
 *
 * Before approval the test is the institute's minimum registration fee. Once the
 * student exists, the registration money lives inside installment 1, so that
 * installment must be settled as well.
 *
 * This only ever clears the flag — granting provisional admission stays an
 * Admin decision.
 */
export async function settleProvisionalAdmission(
  applicationId: string,
  actorId: string | null,
): Promise<{ cleared: boolean }> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      student: {
        include: {
          feeAssignments: {
            orderBy: [{ yearNumber: "asc" }, { createdAt: "asc" }],
            take: 1,
            include: { installments: { orderBy: { seqNo: "asc" }, take: 1 } },
          },
        },
      },
    },
  });
  if (!application || !application.isProvisional) return { cleared: false };

  const config = await getConfig();
  if (application.registrationFeePaidPaise < config.minRegistrationFeePaise) return { cleared: false };

  const firstInstallment = application.student?.feeAssignments[0]?.installments[0];
  if (firstInstallment && firstInstallment.status !== "PAID" && firstInstallment.status !== "WAIVED") {
    return { cleared: false };
  }

  await prisma.application.update({ where: { id: applicationId }, data: { isProvisional: false } });

  // Late fees were suspended while the admission was provisional; now that it is
  // confirmed, bring the cached figures back in line with the live rules.
  if (application.student) {
    const open = await prisma.installment.findMany({
      where: { feeAssignment: { studentId: application.student.id }, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
      select: { id: true },
    });
    for (const installment of open) await refreshInstallment(installment.id);
  }

  await recordAudit({
    userId: actorId,
    action: "application.provisional_cleared",
    entityType: "Application",
    entityId: applicationId,
    summary: `Provisional admission cleared automatically for ${application.fullName} — registration fee settled in full`,
    metadata: {
      registrationFeePaidPaise: application.registrationFeePaidPaise,
      minRegistrationFeePaise: config.minRegistrationFeePaise,
      firstInstallmentStatus: firstInstallment?.status ?? null,
    },
  });

  return { cleared: true };
}

/**
 * The mirror of `settleProvisionalAdmission`. Cancelling a registration-fee
 * receipt takes that money back out, so an admission that stopped being
 * provisional only because the money had arrived goes back to provisional — the
 * state it was in before the payment.
 *
 * The test is the same gate, read the other way: the registration fee must still
 * clear the institute's minimum, and once the student exists the first
 * installment (which is where the registration money lives) must still be
 * settled. If either has stopped being true, the flag goes back on.
 *
 * Late fees are suspended while an admission is provisional, so every open
 * installment is recalculated on the way back exactly as clearing the flag
 * recalculates them on the way forward.
 *
 * Reinstating is automatic because it is a consequence of the money moving.
 * Granting provisional admission in the first place stays an Admin decision.
 */
export async function reinstateProvisionalAdmission(
  applicationId: string,
  actorId: string | null,
  db: Db = prisma,
): Promise<{ reinstated: boolean }> {
  const application = await db.application.findUnique({
    where: { id: applicationId },
    include: {
      student: {
        include: {
          feeAssignments: {
            orderBy: [{ yearNumber: "asc" }, { createdAt: "asc" }],
            take: 1,
            include: { installments: { orderBy: { seqNo: "asc" }, take: 1 } },
          },
        },
      },
    },
  });
  if (!application || application.isProvisional) return { reinstated: false };

  const config = await getConfig(db);
  const firstInstallment = application.student?.feeAssignments[0]?.installments[0];
  const registrationSettled = application.registrationFeePaidPaise >= config.minRegistrationFeePaise;
  const firstInstallmentSettled =
    !firstInstallment || firstInstallment.status === "PAID" || firstInstallment.status === "WAIVED";
  if (registrationSettled && firstInstallmentSettled) return { reinstated: false };

  await db.application.update({ where: { id: applicationId }, data: { isProvisional: true } });

  if (application.student) {
    const open = await db.installment.findMany({
      where: { feeAssignment: { studentId: application.student.id }, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
      select: { id: true },
    });
    for (const installment of open) await refreshInstallment(installment.id, db);
  }

  await recordAuditTx(db, {
    userId: actorId,
    action: "application.provisional_reinstated",
    entityType: "Application",
    entityId: applicationId,
    summary:
      `Provisional admission reinstated automatically for ${application.fullName} — ` +
      `registration fee no longer settled after a receipt was cancelled`,
    metadata: {
      registrationFeePaidPaise: application.registrationFeePaidPaise,
      minRegistrationFeePaise: config.minRegistrationFeePaise,
      firstInstallmentStatus: firstInstallment?.status ?? null,
    },
  });

  return { reinstated: true };
}

/**
 * Duplicate enrollment detection (spec 1.5). Matches on national ID, on the
 * previous enrollment number, and on name + date of birth together.
 */
export async function findDuplicates(
  application: Pick<Application, "id" | "fullName" | "dob" | "nationalId" | "previousEnrollmentNo">,
  db: Db = prisma,
) {
  const clauses: object[] = [];

  if (application.nationalId) clauses.push({ nationalId: application.nationalId });
  if (application.previousEnrollmentNo) {
    clauses.push({ previousEnrollmentNo: application.previousEnrollmentNo });
  }
  if (application.dob) {
    clauses.push({
      AND: [{ fullName: { equals: application.fullName, mode: "insensitive" as const } }, { dob: application.dob }],
    });
  }
  if (clauses.length === 0) return [];

  const matches = await db.application.findMany({
    where: { id: { not: application.id }, OR: clauses },
    select: {
      id: true,
      applicationNo: true,
      fullName: true,
      dob: true,
      status: true,
      nationalId: true,
      studentCode: true,
    },
    take: 10,
  });

  return matches.map((match) => ({
    id: match.id,
    applicationNo: match.applicationNo,
    studentCode: match.studentCode,
    fullName: match.fullName,
    status: match.status,
    reason:
      match.nationalId && match.nationalId === application.nationalId
        ? "Same national ID"
        : "Same name and date of birth",
  }));
}

export const APPLICATION_STATUS_TONE = {
  DRAFT: "neutral",
  SUBMITTED: "info",
  UNDER_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  ENROLLED: "success",
} as const;

export function statusLabel(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}
