import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { PERMISSIONS } from "@/lib/permissions";
import { formatDate, toDateInput } from "@/lib/dates";
import { paiseToRupees } from "@/lib/money";
import { installmentStatusLabel } from "@/lib/students";
import { Alert, LinkButton, PageHeader } from "@/components/ui";
import { FeeAssignmentForm, type EditableInstallment } from "./fee-assignment-form";

export const metadata = { title: "Edit assigned fee" };

const rupees = (paise: number) => paiseToRupees(paise).toFixed(2);

/**
 * Correct the fee assigned to a student for one semester, and the installments
 * under it. Enrollment sets both from the Registrar's plan; this is how a
 * mistyped rate, amount or due date is put right afterwards.
 */
export default async function EditFeeAssignmentPage({
  params,
}: {
  params: Promise<{ id: string; assignmentId: string }>;
}) {
  await requirePermission(PERMISSIONS.FEE_ASSIGN);
  const { id, assignmentId } = await params;

  const [assignment, config] = await Promise.all([
    prisma.feeAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        semester: { select: { semesterNumber: true } },
        academicYear: { select: { name: true } },
        student: {
          select: { id: true, fullName: true, studentCode: true, batch: { select: { completionDate: true } } },
        },
        installments: {
          orderBy: { seqNo: "asc" },
          include: {
            payments: { where: { status: "ACTIVE" } },
            discounts: { where: { cancelledAt: null } },
          },
        },
      },
    }),
    getConfig(),
  ]);
  if (!assignment || assignment.student.id !== id) notFound();

  const { student } = assignment;

  // Extra charges raised after enrollment are separate charges, not part of the
  // agreed plan, so they are listed for context and edited on the record itself.
  const extras = assignment.installments.filter((installment) => installment.extraChargeKind !== null);
  const regulars = assignment.installments.filter((installment) => installment.extraChargeKind === null);

  const rows: EditableInstallment[] = regulars.map((installment) => {
    const paidPrincipal = installment.payments.reduce(
      (sum, payment) => sum + (payment.amountPaise - payment.lateFeePortionPaise),
      0,
    );
    const discounted = installment.discounts.reduce((sum, discount) => sum + discount.amountPaise, 0);

    // Mirrors the server's rules, so a row that cannot be removed says so
    // before the form is submitted rather than after.
    const lockedReason =
      installment.status === "WAIVED"
        ? "Waived"
        : installment.payments.length > 0
          ? "Has payments"
          : discounted > 0
            ? "Has a discount"
            : null;

    return {
      id: installment.id,
      dueDate: toDateInput(installment.dueDate),
      amount: rupees(installment.amountPaise),
      floorPaise: paidPrincipal + discounted,
      lockedReason,
    };
  });

  return (
    <>
      <PageHeader
        title={`Edit assigned fee — semester ${assignment.semester.semesterNumber}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{student.fullName}</span>
            <span className="font-mono">{student.studentCode}</span>
            {assignment.academicYear ? <span>Academic year {assignment.academicYear.name}</span> : null}
          </span>
        }
        actions={
          <LinkButton href={`/students/${id}`} variant="secondary">
            Back to record
          </LinkButton>
        }
      />

      <div className="space-y-6">
        <Alert tone="info" title="What money has already done is kept">
          An installment cannot be cut below what has been paid or discounted against it, and one carrying payments, a
          discount or a waiver cannot be removed — reverse those through their own actions first. Late fees are
          re-assessed against the corrected due dates when this is saved, and the change is written to the audit trail
          with your reason.
        </Alert>

        {assignment.note ? (
          <Alert tone="warning" title="Carried-in balance">
            This assignment was recorded as “{assignment.note}”, not as a normal semester charge. Correcting it here
            changes what the student owes.
          </Alert>
        ) : null}

        <FeeAssignmentForm
          assignmentId={assignment.id}
          completionDate={student.batch.completionDate.toISOString()}
          installmentMin={config.installmentMin}
          installmentMax={config.installmentMax}
          extras={extras.map((installment) => ({
            id: installment.id,
            label: installment.label ?? "Extra charge",
            kind: installment.extraChargeKind ?? "OTHER",
            dueDate: formatDate(installment.dueDate),
            amountPaise: installment.amountPaise,
            status: installmentStatusLabel(installment.status),
          }))}
          initial={{
            lockedTuitionRate: rupees(assignment.lockedTuitionRatePaise),
            // A non-zero paise figure is how a flat concession is recorded; a
            // percentage leaves it at zero (see `resolveScholarship`).
            scholarshipBasis:
              assignment.scholarshipAmountPaise > 0 && assignment.scholarshipPercent === 0 ? "AMOUNT" : "PERCENT",
            scholarshipPercent: String(assignment.scholarshipPercent),
            scholarshipAmount: assignment.scholarshipAmountPaise > 0 ? rupees(assignment.scholarshipAmountPaise) : "",
            examFee: rupees(assignment.examFeePaise),
            activityFee: rupees(assignment.activityFeePaise),
            rows,
          }}
        />
      </div>
    </>
  );
}
