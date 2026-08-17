import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig, getInstitute } from "@/lib/config";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { blockingItems, feePreview, planTotalPaise, submissionReadiness, statusLabel, requiredRegistrationFee } from "@/lib/enrollment";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { Alert, Card, LinkButton, TableWrap, Td, Th, Tr } from "@/components/ui";
import { WelcomeKitActions } from "@/components/welcome-kit-actions";
import { ApprovalPanel, ProvisionalToggle, RejectButton, StartReviewButton, SubmitApplicationButton } from "../decision-panel";
import { FeePreviewCard } from "../fee-preview-card";
import { ReadinessChecklist } from "../readiness-checklist";
import { StepFooter } from "../step-footer";

export const metadata = { title: "Review & decision" };

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(PERMISSIONS.ENROLLMENT_VIEW);
  const { id } = await params;

  const [application, config] = await Promise.all([
    prisma.application.findUnique({
      where: { id },
      include: {
        guardians: true,
        documents: true,
        feePlan: { orderBy: { seqNo: "asc" } },
        batch: { include: { _count: { select: { students: true } } } },
        reviewedBy: { select: { name: true } },
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
  const awaitingDecision = ["SUBMITTED", "UNDER_REVIEW"].includes(application.status);

  const preview = await feePreview(application);
  const planTotal = planTotalPaise(application.feePlan);
  const planSummary =
    application.feePlan.length > 0
      ? `${application.feePlan.length} installment(s) totalling ${formatPaise(planTotal)}, first due ${formatDate(
          application.feePlan[0].dueDate,
        )}`
      : null;

  return (
    <div className="space-y-6">
      {application.status === "DRAFT" ? (
        <Card
          title="Before submission"
          description="Items marked optional are recorded for follow-up and never hold up an Application ID."
        >
          <ReadinessChecklist items={readiness} />
          {canCreate ? (
            <div className="mt-5 border-t border-border pt-4">
              <SubmitApplicationButton applicationId={id} disabled={outstanding.length > 0} />
              {outstanding.length > 0 ? (
                <p className="mt-2 text-xs text-muted">{outstanding.length} step(s) still outstanding.</p>
              ) : null}
            </div>
          ) : (
            <p className="mt-5 border-t border-border pt-4 text-sm text-muted">
              You do not have permission to submit applications.
            </p>
          )}
        </Card>
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

      {awaitingDecision && preview ? <FeePreviewCard preview={preview} enrolled={false} /> : null}

      {application.feePlan.length > 0 ? (
        <Card
          title="Fee plan"
          description={
            preview && planTotal !== preview.totalPayablePaise
              ? `This plan totals ${formatPaise(planTotal)} but the fee is ${formatPaise(
                  preview.totalPayablePaise,
                )} — it must be corrected on the Fee plan tab before approval.`
              : "Entered by the Registrar during enrollment. It becomes the student's installment schedule on approval."
          }
        >
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-16">#</Th>
                <Th>Due date</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {application.feePlan.map((row) => (
                <Tr key={row.id}>
                  <Td className="tabular-nums">{row.seqNo}</Td>
                  <Td className="whitespace-nowrap">{formatDate(row.dueDate)}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(row.amountPaise)}</Td>
                </Tr>
              ))}
            </tbody>
          </TableWrap>
          <p className="mt-3 text-xs text-muted">
            Registration fee received so far: {formatPaise(application.registrationFeePaidPaise)} — applied to
            installment 1 when the student record is created.
          </p>
        </Card>
      ) : null}

      {awaitingDecision && canApprove ? (
        <Card
          title="Admin decision"
          description="Only an Admin can approve or reject. A reason is mandatory either way and is written to the audit trail."
        >
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2">
              {application.status === "SUBMITTED" ? <StartReviewButton applicationId={id} /> : null}
              <ProvisionalToggle applicationId={id} isProvisional={application.isProvisional} />
              <RejectButton applicationId={id} />
            </div>
            <div className="border-t border-border pt-5">
              <ApprovalPanel
                applicationId={id}
                requestedScholarshipPercent={application.requestedScholarshipPercent}
                requestedScholarshipPaise={application.requestedScholarshipPaise}
                requestedLabel={
                  application.requestedScholarshipPaise > 0
                    ? formatPaise(application.requestedScholarshipPaise)
                    : `${application.requestedScholarshipPercent}%`
                }
                planSummary={planSummary}
                seatsLeft={application.batch ? application.batch.totalSeats - application.batch._count.students : 0}
                nextLfNo={config.lfNoNext}
                studentIdPrefix={config.studentIdPrefix}
                lfNoLength={config.lfNoLength}
              />
            </div>
          </div>
        </Card>
      ) : null}

      {awaitingDecision && !canApprove ? (
        <Alert tone="info" title={`Awaiting Admin decision — ${statusLabel(application.status)}`}>
          This application has been submitted. Only a user with the &ldquo;Approve / reject applications&rdquo;
          permission can approve or reject it.
        </Alert>
      ) : null}

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
        <Card
          title="Enrolled"
          description="The welcome kit collects the confirmation letter, admission form, year-wise fee plan, terms & conditions and registration fee receipt into one PDF."
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
          <p className="text-sm">
            This applicant is enrolled as{" "}
            <Link href={`/students/${application.student.id}`} className="font-medium text-brand hover:underline">
              {application.student.studentCode}
            </Link>
            .
          </p>
        </Card>
      ) : null}

      {application.status === "REJECTED" ? (
        <div className="flex justify-end">
          <LinkButton href="/enrollment" variant="secondary">
            Back to applications
          </LinkButton>
        </div>
      ) : (
        <StepFooter
          back={{ href: `/enrollment/${id}/fee`, label: "Back to registration fee" }}
          next={{ href: `/enrollment/${id}`, label: "Overview" }}
        />
      )}
    </div>
  );
}
