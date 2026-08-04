import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { formatDate } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { waivableLateFeePaise } from "@/lib/late-fees";
import {
  INSTALLMENT_STATUS_TONE,
  STUDENT_STATUS_TONE,
  discountReasonLabel,
  installmentStatusLabel,
  studentStatusLabel,
} from "@/lib/students";
import { hasPermission } from "@/lib/permissions";
import { scholarshipLabel } from "@/lib/enrollment";
import {
  Badge,
  Card,
  DescriptionList,
  LinkButton,
  PageHeader,
  StatTile,
  TableWrap,
  Td,
  Th,
  Tr,
  buttonClass,
} from "@/components/ui";
import {
  AddExtraChargeButton,
  BacklogToggle,
  StatusChangeButton,
  UnwaiveInstallmentButton,
  WaiveInstallmentButton,
  GrantDiscountButton,
  CancelDiscountButton,
  RestoreLateFeeButton,
} from "./student-actions";
import { WaiveLateFeeButton } from "@/components/waive-late-fee-button";

export const metadata = { title: "Student record" };

export default async function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(PERMISSIONS.STUDENT_VIEW);
  const canChangeStatus = hasPermission(actor.permissions, PERMISSIONS.STUDENT_STATUS_CHANGE);
  const canWaive = hasPermission(actor.permissions, PERMISSIONS.FEE_WAIVE);
  const canDiscount = hasPermission(actor.permissions, PERMISSIONS.FEE_DISCOUNT);
  const canWaiveLateFee = hasPermission(actor.permissions, PERMISSIONS.FEE_WAIVE_LATE_FEE);
  // Correcting admission details — the student's own record and the application
  // it prints from — is the same authority as filling that form in the first
  // place. Guardian rows live on the application, so they are edited there.
  const canEditProfile = hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_CREATE);
  const canEditGuardians = canEditProfile;
  const canEditFees = hasPermission(actor.permissions, PERMISSIONS.FEE_ASSIGN);
  const { id } = await params;

  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      department: true,
      course: true,
      batch: true,
      currentSemester: true,
      application: { include: { guardians: true } },
      statusHistory: { include: { changedBy: { select: { name: true } } }, orderBy: { changedAt: "desc" } },
      feeAssignments: {
        include: {
          semester: true,
          academicYear: true,
          installments: {
            orderBy: { seqNo: "asc" },
            include: { payments: { where: { status: "ACTIVE" } }, discounts: { orderBy: { grantedAt: "asc" } } },
          },
        },
        orderBy: [{ yearNumber: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  if (!student) notFound();

  const allInstallments = student.feeAssignments.flatMap((fa) => fa.installments);
  const assigned = student.feeAssignments.reduce((sum, fa) => sum + fa.totalPayablePaise, 0);
  const waived = allInstallments
    .filter((i) => i.status === "WAIVED")
    .reduce((sum, i) => sum + i.amountPaise, 0);
  const paid = allInstallments
    .flatMap((i) => i.payments)
    .reduce((sum, p) => sum + p.amountPaise, 0);
  const lateFees = allInstallments
    .filter((i) => i.status !== "WAIVED")
    .reduce((sum, i) => sum + i.lateFeePaise, 0);
  // A discount reduces what is owed without reducing what was assigned, so it
  // comes off the outstanding figure just as a payment does.
  const discounted = allInstallments
    .filter((i) => i.status !== "WAIVED")
    .reduce((sum, i) => sum + i.discountPaise, 0);
  const outstanding = Math.max(0, assigned - waived - discounted - paid + lateFees);

  // What a whole-balance discount could still reduce: the unpaid installments,
  // net of what has already been paid or discounted on each.
  const unpaidInstallments = allInstallments.filter((i) => i.status !== "PAID" && i.status !== "WAIVED");
  const unpaidRoom = unpaidInstallments.reduce((sum, i) => {
    const paidOnIt = i.payments.reduce((total, p) => total + (p.amountPaise - p.lateFeePortionPaise), 0);
    return sum + Math.max(0, i.amountPaise - i.discountPaise - paidOnIt);
  }, 0);
  const unpaidCount = unpaidInstallments.length;

  // An extra charge is billed against one semester's assignment, defaulting to
  // the one the student is sitting in now.
  const chargeableAssignments = student.feeAssignments.map((assignment) => ({
    id: assignment.id,
    label: `Semester ${assignment.semester.semesterNumber} — Year ${assignment.yearNumber}${
      assignment.semesterId === student.currentSemesterId ? " (current)" : ""
    }`,
  }));
  const defaultAssignmentId =
    student.feeAssignments.find((assignment) => assignment.semesterId === student.currentSemesterId)?.id ??
    student.feeAssignments[student.feeAssignments.length - 1]?.id ??
    "";

  return (
    <>
      <PageHeader
        title={student.fullName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{student.studentCode}</span>
            <Badge tone={STUDENT_STATUS_TONE[student.status]}>{studentStatusLabel(student.status)}</Badge>
            {student.hasBacklog ? <Badge tone="warning">Backlog / reappear</Badge> : null}
          </span>
        }
        actions={
          <>
            {canEditProfile ? (
              <LinkButton href={`/students/${student.id}/edit`} variant="secondary">
                Edit profile
              </LinkButton>
            ) : null}
            <a
              href={`/api/applications/${student.applicationId}/welcome-kit`}
              target="_blank"
              rel="noreferrer"
              className={buttonClass("secondary")}
            >
              Welcome kit
            </a>
            <LinkButton href={`/fees/collect?studentId=${student.id}`} variant="secondary">
              Collect fees
            </LinkButton>
            <LinkButton href={`/reports/ledger?studentId=${student.id}`} variant="secondary">
              Ledger
            </LinkButton>
            {canDiscount && unpaidRoom > 0 ? (
              <GrantDiscountButton
                studentId={student.id}
                totalOutstandingLabel={formatPaise(unpaidRoom)}
                unpaidCount={unpaidCount}
                trigger="header"
              />
            ) : null}
            {canEditFees && chargeableAssignments.length > 0 ? (
              <AddExtraChargeButton
                assignments={chargeableAssignments}
                defaultAssignmentId={defaultAssignmentId}
              />
            ) : null}
            {canChangeStatus ? (
              <>
                <BacklogToggle studentId={student.id} hasBacklog={student.hasBacklog} />
                <StatusChangeButton studentId={student.id} currentStatus={student.status} />
              </>
            ) : null}
          </>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Fees assigned" value={formatPaise(assigned)} />
        <StatTile label="Paid" value={formatPaise(paid)} tone="success" />
        <StatTile
          label="Discounted"
          value={formatPaise(discounted)}
          tone={discounted > 0 ? "success" : "default"}
          hint={waived > 0 ? `Plus ${formatPaise(waived)} waived` : undefined}
        />
        <StatTile
          label="Outstanding"
          value={formatPaise(outstanding)}
          tone={outstanding > 0 ? "danger" : "success"}
          hint={lateFees > 0 ? `Includes ${formatPaise(lateFees)} late fee` : undefined}
        />
      </div>

      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Student">
            <DescriptionList
              items={[
                { label: "Student ID", value: student.studentCode },
                { label: "LF No.", value: student.lfNo },
                { label: "Date of birth", value: formatDate(student.dob) },
                { label: "Gender", value: student.gender.charAt(0) + student.gender.slice(1).toLowerCase() },
                { label: "Blood group", value: student.bloodGroup ?? "—" },
                { label: "Phone", value: student.phone ?? "—" },
                { label: "Email", value: student.email ?? "—" },
                {
                  label: "Address",
                  value:
                    [student.addressLine1, student.addressLine2, student.city, student.state, student.pincode]
                      .filter(Boolean)
                      .join(", ") || "—",
                },
                {
                  label: "Application",
                  value: (
                    <Link href={`/enrollment/${student.applicationId}`} className="text-brand hover:underline">
                      {student.application.applicationNo ?? "View"}
                    </Link>
                  ),
                },
              ]}
            />
          </Card>

          <Card title="Academic">
            <DescriptionList
              items={[
                { label: "Department", value: student.department.name },
                { label: "Course", value: student.course.name },
                { label: "Batch", value: student.batch.name },
                { label: "Current semester", value: student.currentSemester?.semesterNumber ?? "—" },
                { label: "Enrollment date", value: formatDate(student.enrollmentDate) },
                { label: "Batch completion", value: formatDate(student.batch.completionDate) },
                { label: "Status reason", value: student.statusReason ?? "—" },
                { label: "Backlog remark", value: student.backlogRemark ?? "—" },
              ]}
            />
          </Card>
        </div>

        <Card
          title="Guardians"
          actions={
            canEditGuardians ? (
              <LinkButton
                href={`/enrollment/${student.applicationId}/guardians`}
                variant="secondary"
                size="sm"
              >
                Edit guardians
              </LinkButton>
            ) : null
          }
        >
          {student.application.guardians.length === 0 ? (
            <p className="text-sm text-muted">No guardians recorded.</p>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>Relationship</Th>
                  <Th>Name</Th>
                  <Th>Occupation</Th>
                  <Th>Phone</Th>
                  <Th>Email</Th>
                </tr>
              </thead>
              <tbody>
                {student.application.guardians.map((guardian) => (
                  <Tr key={guardian.id}>
                    <Td>
                      {guardian.relation.charAt(0) + guardian.relation.slice(1).toLowerCase()}
                      {guardian.isPrimary ? <Badge tone="info">Primary</Badge> : null}
                    </Td>
                    <Td className="font-medium">{guardian.name}</Td>
                    <Td>{guardian.occupation ?? "—"}</Td>
                    <Td>{guardian.phone ?? "—"}</Td>
                    <Td>{guardian.email ?? "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        {student.statusHistory.length > 0 ? (
          <Card title="Status history">
            <TableWrap>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>From → To</Th>
                  <Th>Reason</Th>
                  <Th>Changed by</Th>
                </tr>
              </thead>
              <tbody>
                {student.statusHistory.map((entry) => (
                  <Tr key={entry.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDate(entry.changedAt)}</Td>
                    <Td>
                      {studentStatusLabel(entry.fromStatus)} → {studentStatusLabel(entry.toStatus)}
                    </Td>
                    <Td className="max-w-md">{entry.reason ?? "—"}</Td>
                    <Td className="text-muted">{entry.changedBy?.name ?? "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>
        ) : null}

        {student.feeAssignments.map((assignment) => (
          <Card
            key={assignment.id}
            title={`Semester ${assignment.semester.semesterNumber} — Year ${assignment.yearNumber}`}
            description={assignment.academicYear ? `Academic year ${assignment.academicYear.name}` : undefined}
            actions={
              canEditFees ? (
                <LinkButton
                  href={`/students/${student.id}/fees/${assignment.id}`}
                  variant="secondary"
                  size="sm"
                >
                  Edit assigned fee
                </LinkButton>
              ) : null
            }
          >
            <DescriptionList
              items={[
                { label: "Locked tuition rate", value: formatPaise(assignment.lockedTuitionRatePaise) },
                {
                  label: "Scholarship",
                  value:
                    assignment.scholarshipAmountPaise > 0
                      ? scholarshipLabel(assignment.scholarshipPercent, assignment.scholarshipAmountPaise)
                      : "None",
                },
                { label: "Tuition charged", value: formatPaise(assignment.tuitionComponentPaise) },
                { label: "Exam fee", value: formatPaise(assignment.examFeePaise) },
                { label: "Activity fee", value: formatPaise(assignment.activityFeePaise) },
                {
                  label: "Total payable",
                  value: <span className="font-semibold">{formatPaise(assignment.totalPayablePaise)}</span>,
                },
              ]}
            />

            <div className="mt-5">
              <TableWrap>
                <thead>
                  <tr>
                    <Th className="w-16">#</Th>
                    <Th>Due date</Th>
                    <Th className="text-right">Amount</Th>
                    <Th className="text-right">Discount</Th>
                    <Th className="text-right">Paid</Th>
                    <Th className="text-right">Late fee</Th>
                    <Th>Status</Th>
                    {canWaive || canDiscount || canWaiveLateFee ? <Th className="w-56" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {assignment.installments.map((installment) => {
                    const installmentPaid = installment.payments.reduce((sum, p) => sum + p.amountPaise, 0);
                    const active = installment.discounts.filter((discount) => !discount.cancelledAt);
                    const outstanding = Math.max(
                      0,
                      installment.amountPaise - installment.discountPaise - installmentPaid,
                    );
                    // A late fee that has been collected is still waivable — the
                    // money is credited back rather than refunded.
                    const lateFee = waivableLateFeePaise({
                      assessedPaise: installment.lateFeePaise,
                      waivedPaise: installment.lateFeeWaivedPaise,
                      paidPaise: installment.payments.reduce((sum, p) => sum + p.lateFeePortionPaise, 0),
                      creditedPaise: installment.lateFeeCreditedPaise,
                    });
                    return (
                      <Tr key={installment.id}>
                        <Td className="tabular-nums">{installment.seqNo}</Td>
                        <Td className="whitespace-nowrap">
                          {formatDate(installment.dueDate)}
                          {/* An extra charge is not part of the agreed plan, so it says what it is. */}
                          {installment.extraChargeKind ? (
                            <span className="block text-xs text-muted">
                              {installment.label ?? "Extra charge"} ·{" "}
                              {installment.extraChargeKind.charAt(0) +
                                installment.extraChargeKind.slice(1).toLowerCase()}
                            </span>
                          ) : null}
                        </Td>
                        <Td className="text-right tabular-nums">{formatPaise(installment.amountPaise)}</Td>
                        <Td className="text-right tabular-nums">
                          {installment.discountPaise > 0 ? (
                            <>
                              <span className="text-success">− {formatPaise(installment.discountPaise)}</span>
                              {active.map((discount) => (
                                <span key={discount.id} className="block text-xs text-muted">
                                  {discountReasonLabel(discount.reason)}
                                  {discount.percent ? ` · ${discount.percent}%` : ""}
                                  {canDiscount ? (
                                    <CancelDiscountButton
                                      discountId={discount.id}
                                      amountLabel={formatPaise(discount.amountPaise)}
                                    />
                                  ) : null}
                                </span>
                              ))}
                            </>
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td className="text-right tabular-nums">{formatPaise(installmentPaid)}</Td>
                        <Td className="text-right tabular-nums">
                          {installment.lateFeeCreditedPaise > 0 ? (
                            <span className="block text-xs text-muted">
                              {formatPaise(installment.lateFeeCreditedPaise)} collected, waived and credited
                            </span>
                          ) : null}
                          {installment.lateFeeWaived ? (
                            <span className="text-xs text-muted">Waived</span>
                          ) : installment.lateFeeWaivedPaise > 0 ? (
                            <>
                              <span className="text-danger">
                                {formatPaise(installment.lateFeePaise - installment.lateFeeWaivedPaise)}
                              </span>
                              <span className="block text-xs text-muted">
                                {formatPaise(installment.lateFeeWaivedPaise)} waived
                              </span>
                            </>
                          ) : installment.lateFeePaise > 0 ? (
                            <span className="text-danger">{formatPaise(installment.lateFeePaise)}</span>
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td>
                          <Badge tone={INSTALLMENT_STATUS_TONE[installment.status]}>
                            {installmentStatusLabel(installment.status)}
                          </Badge>
                          {installment.waivedReason ? (
                            <p className="text-xs text-muted">{installment.waivedReason}</p>
                          ) : null}
                        </Td>
                        {canWaive || canDiscount || canWaiveLateFee ? (
                          <Td>
                            <div className="flex flex-wrap gap-1">
                              {canDiscount && installment.status !== "WAIVED" && outstanding > 0 ? (
                                <GrantDiscountButton
                                  studentId={student.id}
                                  installmentId={installment.id}
                                  installmentLabel={`installment ${installment.seqNo}`}
                                  outstandingLabel={formatPaise(outstanding)}
                                  totalOutstandingLabel={formatPaise(unpaidRoom)}
                                  unpaidCount={unpaidCount}
                                  trigger="row"
                                />
                              ) : null}
                              {canWaiveLateFee && installment.status !== "WAIVED" ? (
                                lateFee.totalPaise > 0 ? (
                                  <WaiveLateFeeButton
                                    installmentId={installment.id}
                                    outstandingLateFeeLabel={formatPaise(lateFee.totalPaise)}
                                    collectedLateFeeLabel={
                                      lateFee.collectedPaise > 0 ? formatPaise(lateFee.collectedPaise) : undefined
                                    }
                                  />
                                ) : installment.lateFeeWaived || installment.lateFeeWaivedPaise > 0 ? (
                                  <RestoreLateFeeButton installmentId={installment.id} />
                                ) : null
                              ) : null}
                              {canWaive ? (
                                installment.status === "WAIVED" ? (
                                  student.status === "ACTIVE" ? (
                                    <UnwaiveInstallmentButton installmentId={installment.id} />
                                  ) : null
                                ) : installment.status !== "PAID" ? (
                                  <WaiveInstallmentButton installmentId={installment.id} />
                                ) : null
                              ) : null}
                            </div>
                          </Td>
                        ) : null}
                      </Tr>
                    );
                  })}
                </tbody>
              </TableWrap>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
