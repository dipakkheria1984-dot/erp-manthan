import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig, getInstitute } from "@/lib/config";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { blockingItems, feePreview, submissionReadiness, statusLabel, requiredRegistrationFee } from "@/lib/enrollment";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { Alert, Card, DescriptionList, LinkButton, buttonClass } from "@/components/ui";
import { WelcomeKitActions } from "@/components/welcome-kit-actions";
import { DiscardDraftButton } from "./decision-panel";
import { FeePreviewCard } from "./fee-preview-card";
import { ReadinessChecklist } from "./readiness-checklist";

export const metadata = { title: "Application overview" };

export default async function ApplicationOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(PERMISSIONS.ENROLLMENT_VIEW);
  const { id } = await params;

  const [application, config] = await Promise.all([
    prisma.application.findUnique({
      where: { id },
      include: {
        guardians: true,
        documents: true,
        feePlan: { orderBy: { seqNo: "asc" } },
        batch: { include: { course: true, _count: { select: { students: true } } } },
        course: true,
        department: true,
        academicYear: true,
        reviewedBy: { select: { name: true } },
        createdBy: { select: { name: true } },
        student: { select: { id: true, studentCode: true } },
      },
    }),
    getConfig(),
  ]);
  if (!application) notFound();

  const institute = await getInstitute().catch(() => null);
  const readiness = await submissionReadiness(application, await requiredRegistrationFee(application));
  const outstanding = blockingItems(readiness);
  const canCreate = hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_CREATE);
  const canApprove = hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_APPROVE);

  // Preview the fee that approval would lock in, so the Admin decides with the
  // actual numbers in front of them.
  const preview = await feePreview(application);

  const duplicates = (application.duplicateFlags ?? []) as {
    id: string;
    applicationNo: string | null;
    studentCode: string | null;
    fullName: string;
    status: string;
    reason: string;
  }[];

  return (
    <div className="space-y-6">
      <div className="no-print flex justify-end">
        <a
          href={`/api/applications/${id}/form`}
          target="_blank"
          rel="noreferrer"
          className={buttonClass("secondary", "sm")}
        >
          Print admission form
        </a>
      </div>

      {application.status === "DRAFT" ? (
        <Card
          title="Draft"
          description={
            outstanding.length > 0
              ? `Still needed before submission: ${outstanding.map((item) => item.label.toLowerCase()).join(", ")}.`
              : "Everything required is complete — the application is ready to be submitted."
          }
          actions={
            canCreate ? (
              <div className="flex flex-wrap gap-2">
                <LinkButton href={`/enrollment/${id}/review`}>
                  {outstanding.length > 0 ? "Open review checklist" : "Review & submit"}
                </LinkButton>
                <DiscardDraftButton applicationId={id} />
              </div>
            ) : null
          }
        >
          <ReadinessChecklist items={readiness} />
        </Card>
      ) : null}

      {["SUBMITTED", "UNDER_REVIEW"].includes(application.status) ? (
        <Card
          title={canApprove ? "Waiting on your decision" : "Awaiting Admin decision"}
          description={
            canApprove
              ? "Approve and enrol, reject, or grant provisional admission from the Review & decision tab."
              : "Only a user with the approve / reject permission can decide this application."
          }
          actions={
            canApprove ? (
              <LinkButton href={`/enrollment/${id}/review`}>Approve or reject</LinkButton>
            ) : (
              <LinkButton href={`/enrollment/${id}/review`} variant="secondary">
                Open review
              </LinkButton>
            )
          }
        >
          <p className="text-sm text-muted">
            Status: {statusLabel(application.status)}
            {application.submittedAt ? ` · submitted ${formatDateTime(application.submittedAt)}` : ""}
          </p>
        </Card>
      ) : null}

      {duplicates.length > 0 ? (
        <Alert tone="warning" title={`${duplicates.length} possible duplicate enrollment(s) flagged`}>
          <ul className="mt-1 space-y-1">
            {duplicates.map((dup) => (
              <li key={dup.id}>
                <Link href={`/enrollment/${dup.id}`} className="underline">
                  {dup.applicationNo ?? dup.studentCode ?? dup.fullName}
                </Link>{" "}
                — {dup.fullName} ({statusLabel(dup.status)}) · {dup.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {application.scholarshipNeedsApproval ? (
        <Alert tone="warning" title="Scholarship needs Admin approval">
          A discount of{" "}
          {application.requestedScholarshipPaise > 0
            ? formatPaise(application.requestedScholarshipPaise)
            : `${application.requestedScholarshipPercent}%`}{" "}
          has been requested. It has not been applied — an Admin
          must set the final figure when approving.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Applicant">
          <DescriptionList
            items={[
              { label: "Full name", value: application.fullName },
              { label: "Gender", value: application.gender.charAt(0) + application.gender.slice(1).toLowerCase() },
              { label: "Date of birth", value: formatDate(application.dob) },
              { label: "Blood group", value: application.bloodGroup ?? "—" },
              { label: "Phone", value: application.phone ?? "—" },
              { label: "Email", value: application.email ?? "—" },
              {
                label: "Address",
                value:
                  [application.addressLine1, application.addressLine2, application.city, application.state, application.pincode]
                    .filter(Boolean)
                    .join(", ") || "—",
              },
              { label: "National ID", value: application.nationalId ?? "—" },
              { label: "Previous institution", value: application.previousInstitution ?? "—" },
              { label: "Previous marks", value: application.previousMarks ?? "—" },
            ]}
          />
        </Card>

        <Card title="Admission">
          <DescriptionList
            items={[
              { label: "Academic year", value: application.academicYear?.name ?? "—" },
              { label: "Department", value: application.department?.name ?? "—" },
              { label: "Course", value: application.course?.name ?? "—" },
              { label: "Batch", value: application.batch?.name ?? "—" },
              { label: "Guardians on record", value: application.guardians.length },
              { label: "Documents uploaded", value: application.documents.length },
              { label: "Registration fee paid", value: formatPaise(application.registrationFeePaidPaise) },
              { label: "Created by", value: application.createdBy?.name ?? "—" },
              { label: "Submitted", value: formatDateTime(application.submittedAt) },
              { label: "Reviewed by", value: application.reviewedBy?.name ?? "—" },
            ]}
          />
        </Card>
      </div>

      {preview ? <FeePreviewCard preview={preview} enrolled={application.status === "ENROLLED"} /> : null}

      {application.decisionReason ? (
        <Card title="Decision">
          <p className="text-sm">{application.decisionReason}</p>
          <p className="mt-1 text-xs text-muted">
            {statusLabel(application.status)} · {formatDateTime(application.reviewedAt)} ·{" "}
            {application.reviewedBy?.name ?? "—"}
          </p>
        </Card>
      ) : null}

      {application.student ? (
        <>
          <Card title="Enrolled">
            <p className="text-sm">
              This applicant is enrolled as{" "}
              <Link href={`/students/${application.student.id}`} className="font-medium text-brand hover:underline">
                {application.student.studentCode}
              </Link>
              .
            </p>
          </Card>

          <Card
            title="Welcome kit"
            description="One printable PDF to hand over or email to the family."
            actions={
              <WelcomeKitActions
                applicationId={id}
                size="sm"
                studentName={application.fullName}
                studentCode={application.student.studentCode}
                instituteName={institute?.name}
                defaultTo={application.email}
              />
            }
          >
            <ol className="list-inside list-decimal space-y-1 text-sm text-muted">
              <li>Welcome &amp; admission confirmation letter</li>
              <li>Admission form as recorded by the institute</li>
              <li>Year-wise fee payment plan and installment schedule</li>
              <li>Terms &amp; conditions in force</li>
              <li>Registration fee receipt</li>
            </ol>
            <p className="mt-3 text-xs text-muted">
              The copied link only opens for signed-in staff — send families the downloaded file.
            </p>
          </Card>
        </>
      ) : null}

      {application.status === "REJECTED" ? (
        <div className="flex justify-end">
          <LinkButton href="/enrollment" variant="secondary">
            Back to applications
          </LinkButton>
        </div>
      ) : null}
    </div>
  );
}
