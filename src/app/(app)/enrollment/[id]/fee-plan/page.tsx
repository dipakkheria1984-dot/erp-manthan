import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { feePreview, requiredRegistrationFee } from "@/lib/enrollment";
import { formatDate, toDateInput } from "@/lib/dates";
import { formatPaise, paiseToRupees } from "@/lib/money";
import { Alert, Badge, Card, LinkButton, TableWrap, Td, Th, Tr } from "@/components/ui";
import { FeePlanForm } from "./fee-plan-form";
import { StepFooter } from "../step-footer";

export const metadata = { title: "Fee plan" };

export default async function FeePlanPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(PERMISSIONS.ENROLLMENT_VIEW);
  const { id } = await params;

  const [application, config] = await Promise.all([
    prisma.application.findUnique({
      where: { id },
      include: { batch: true, feePlan: { orderBy: { seqNo: "asc" } } },
    }),
    getConfig(),
  ]);
  if (!application) notFound();

  const preview = await feePreview(application);
  const canEdit =
    hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_CREATE) &&
    ["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(application.status);

  const footer = (
    <StepFooter
      back={{ href: `/enrollment/${id}/documents`, label: "Back to documents" }}
      next={{ href: `/enrollment/${id}/fee`, label: "Continue to registration fee" }}
    />
  );

  if (!application.batch || !preview) {
    return (
      <div className="space-y-6">
        <Alert tone="warning" title="Select the course and batch first">
          The fee total comes from the batch, so the installment plan can only be entered once step 3 is done.
        </Alert>
        <LinkButton href={`/enrollment/${id}/course`}>Go to course selection</LinkButton>
        {footer}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Alert tone="info" title="The plan covers the whole first-semester fee">
        The registration fee collected at enrollment is part of this total, not an extra charge — it is applied to
        installment 1 when the student record is created. Every due date must fall on or before the batch completion
        date, {formatDate(application.batch.completionDate)}.
      </Alert>

      {application.scholarshipNeedsApproval ? (
        <Alert tone="warning" title="Scholarship still needs Admin approval">
          The plan below is built on the{" "}
          {application.requestedScholarshipPaise > 0
            ? formatPaise(application.requestedScholarshipPaise)
            : `${application.requestedScholarshipPercent}%`}{" "}
          requested. If the Admin approves a
          different figure, the total changes and the plan has to be updated before the application can be approved.
        </Alert>
      ) : null}

      {preview.examFeePaise === 0 || preview.activityFeePaise === 0 ? (
        <Alert tone="warning" title="Exam and activity fees are not set for this batch">
          Semester 1 of {application.batch.code} has {preview.examFeePaise === 0 ? "no exam fee" : ""}
          {preview.examFeePaise === 0 && preview.activityFeePaise === 0 ? " and " : ""}
          {preview.activityFeePaise === 0 ? "no activity fee" : ""} configured, so nothing is being added for{" "}
          {preview.examFeePaise === 0 && preview.activityFeePaise === 0 ? "them" : "it"}. Set the semester fees on the{" "}
          <Link href={`/academic/batches/${application.batchId}`} className="underline">
            batch page
          </Link>{" "}
          first — then reopen this step and the total will include them.
        </Alert>
      ) : null}

      {canEdit ? (
        <FeePlanForm
          applicationId={id}
          initialRows={application.feePlan.map((row) => ({
            dueDate: toDateInput(row.dueDate),
            amount: paiseToRupees(row.amountPaise).toFixed(2),
          }))}
          breakdown={{
            lockedRatePaise: preview.lockedRatePaise,
            examFeePaise: preview.examFeePaise,
            activityFeePaise: preview.activityFeePaise,
            scholarshipPercent: preview.scholarshipPercent,
            scholarshipAmountPaise: preview.scholarshipAmountPaise,
            totalPayablePaise: preview.totalPayablePaise,
          }}
          registrationPaidPaise={preview.registrationPaidPaise}
          firstInstallmentPaise={await requiredRegistrationFee(application)}
          completionDate={application.batch.completionDate.toISOString()}
          installmentMin={config.installmentMin}
          installmentMax={config.installmentMax}
        />
      ) : (
        <Card
          title="Installment plan"
          description={`Total fee assignable ${formatPaise(preview.totalPayablePaise)} = batch fee ${formatPaise(
            preview.lockedRatePaise,
          )} + exam ${formatPaise(preview.examFeePaise)} + activity ${formatPaise(
            preview.activityFeePaise,
          )} − scholarship ${formatPaise(preview.scholarshipAmountPaise)}.`}
        >
          {application.feePlan.length === 0 ? (
            <p className="text-sm text-muted">No installment plan has been entered.</p>
          ) : (
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
          )}
          {application.status === "ENROLLED" ? (
            <p className="mt-3 text-sm text-muted">
              <Badge tone="success">Enrolled</Badge> This plan is now the student&apos;s live installment schedule.
            </p>
          ) : null}
        </Card>
      )}

      {footer}
    </div>
  );
}
