import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { PERMISSIONS } from "@/lib/permissions";
import { formatDate, startOfDay, toDateInput } from "@/lib/dates";
import { formatPaise, paiseToRupees } from "@/lib/money";
import { installmentsFitting, tuitionRateAt } from "@/lib/fees";
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
  Alert,
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
  AssignFeeButton,
  BacklogToggle,
  StatusChangeButton,
  UnwaiveInstallmentButton,
  WaiveInstallmentButton,
  GrantDiscountButton,
  CancelDiscountButton,
  RestoreLateFeeButton,
  type AssignableSemester,
} from "./student-actions";
import { WaiveLateFeeButton } from "@/components/waive-late-fee-button";
import { Prisma } from "@/generated/prisma/client";

export const metadata = { title: "Student record" };

/**
 * The student's course-change history — or nothing, when the table is not there.
 *
 * Migrations are deliberately not part of the build (see DEPLOYMENT.md), so a
 * deployment can reach production minutes before its migration does. That gap
 * has already cost this page once: the history is one card near the bottom, and
 * it should not be able to take a student's whole record down with it.
 *
 * Only "the table does not exist" is swallowed, and it is logged where the
 * deployment logs will show it. Every other database error still throws.
 */
async function loadCourseChanges(studentId: string) {
  try {
    return await prisma.courseChange.findMany({
      where: { studentId },
      include: {
        fromCourse: { select: { name: true } },
        toCourse: { select: { name: true } },
        fromBatch: { select: { code: true } },
        toBatch: { select: { code: true } },
        changedBy: { select: { name: true } },
      },
      orderBy: { changedAt: "desc" },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
      console.error(
        "[students] The CourseChange table is missing, so the course-change history is hidden. " +
          "The database is behind the deployment — run `npm run db:deploy` against the direct connection.",
      );
      return [];
    }
    throw error;
  }
}

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
  const canChangeCourse = hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_CHANGE_COURSE);
  const { id } = await params;

  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      department: true,
      course: true,
      batch: { include: { semesters: { orderBy: { semesterNumber: "asc" } } } },
      currentSemester: true,
      application: { include: { guardians: true } },
      statusHistory: { include: { changedBy: { select: { name: true } } }, orderBy: { changedAt: "desc" } },
      // Read at student level rather than through the installments: a course
      // change can leave money the new fee could not absorb sitting on the
      // record with nothing to point at, and it is still the family's.
      payments: { where: { status: "ACTIVE" }, select: { amountPaise: true, installmentId: true } },
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

  const courseChanges = await loadCourseChanges(id);

  const allInstallments = student.feeAssignments.flatMap((fa) => fa.installments);
  const assigned = student.feeAssignments.reduce((sum, fa) => sum + fa.totalPayablePaise, 0);
  const waived = allInstallments
    .filter((i) => i.status === "WAIVED")
    .reduce((sum, i) => sum + i.amountPaise, 0);
  const paid = student.payments.reduce((sum, p) => sum + p.amountPaise, 0);
  // Money received with no installment to settle — what a move to a cheaper
  // course leaves over. It counts as paid and waits for the next semester's bill.
  const unappliedCredit = student.payments
    .filter((p) => p.installmentId === null)
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

  /* ---------------------------------------------------------------------- */
  /* Semesters that have never been billed                                   */
  /* ---------------------------------------------------------------------- */

  // Approval bills the first semester and a promotion run bills the one it moves
  // a cohort into, so a student who arrived by bulk import can sit mid-course
  // with semesters that were never charged at all. Those are what "Assign fee"
  // offers; a semester already carrying an assignment is corrected through the
  // edit screen instead.
  const config = await getConfig();
  const assignedSemesterIds = new Set(student.feeAssignments.map((assignment) => assignment.semesterId));
  const unbilledSemesters = student.batch.semesters.filter((semester) => !assignedSemesterIds.has(semester.id));

  // Tuition is a charge on the year of the course, carried by the semester that
  // opens it (spec 6.4) — so it is offered only there, and only when no
  // assignment in that year is already charging it.
  const firstSemesterOfYear = new Map<number, number>();
  for (const semester of student.batch.semesters) {
    const lowest = firstSemesterOfYear.get(semester.yearNumber);
    if (lowest === undefined || semester.semesterNumber < lowest) {
      firstSemesterOfYear.set(semester.yearNumber, semester.semesterNumber);
    }
  }
  const yearsAlreadyCharged = new Set(
    student.feeAssignments.filter((a) => a.tuitionComponentPaise > 0).map((a) => a.yearNumber),
  );

  const lockedRatePaise = unbilledSemesters.length > 0 ? await tuitionRateAt(student.batchId, student.enrollmentDate) : 0;
  const rupeeField = (paise: number) => paiseToRupees(paise).toFixed(2);

  const assignableSemesters: AssignableSemester[] = unbilledSemesters.map((semester) => {
    const opensYear = firstSemesterOfYear.get(semester.yearNumber) === semester.semesterNumber;
    const yearCharged = yearsAlreadyCharged.has(semester.yearNumber);
    const offersTuition = opensYear && !yearCharged;
    return {
      id: semester.id,
      label: `Semester ${semester.semesterNumber} — Year ${semester.yearNumber}${
        semester.id === student.currentSemesterId ? " (current)" : ""
      }`,
      tuition: rupeeField(offersTuition ? lockedRatePaise : 0),
      examFee: rupeeField(semester.examFeePaise),
      activityFee: rupeeField(semester.activityFeePaise),
      tuitionHint: offersTuition
        ? `The rate locked to their enrollment date, ${formatDate(student.enrollmentDate)}. Tuition is charged once per year of the course, on the semester that opens it.`
        : yearCharged
          ? `Year ${semester.yearNumber} tuition is already charged on another semester — leave this at zero unless you mean to charge it twice.`
          : `Semester ${semester.semesterNumber} does not open a year of the course, so it normally carries exam and activity fees only.`,
    };
  });

  // A semester the student has not reached is *meant* to carry no fee — the
  // promotion run bills each one as the cohort moves into it. Only a gap at or
  // behind where they are sitting is a student going uncharged, which is the
  // case worth putting in front of the Registrar.
  const currentSemesterNumber = student.currentSemester?.semesterNumber ?? 0;
  const gapSemesters = unbilledSemesters.filter((semester) => semester.semesterNumber <= currentSemesterNumber);
  const defaultSemesterId = (gapSemesters[0] ?? unbilledSemesters[0])?.id ?? "";

  const today = startOfDay(new Date());
  const fitting = installmentsFitting(today, student.batch.completionDate);
  const defaultInstallmentCount = Math.max(config.installmentMin, Math.min(config.installmentMax, fitting || 1));
  const canAssignFee = canEditFees && assignableSemesters.length > 0;

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
            {canAssignFee ? (
              <AssignFeeButton
                studentId={student.id}
                semesters={assignableSemesters}
                defaultSemesterId={defaultSemesterId}
                installmentMin={config.installmentMin}
                installmentMax={config.installmentMax}
                defaultInstallmentCount={defaultInstallmentCount}
                defaultFirstDueDate={toDateInput(today)}
                completionDate={toDateInput(student.batch.completionDate)}
                completionDateLabel={formatDate(student.batch.completionDate)}
              />
            ) : null}
            {canEditFees && chargeableAssignments.length > 0 ? (
              <AddExtraChargeButton
                assignments={chargeableAssignments}
                defaultAssignmentId={defaultAssignmentId}
              />
            ) : null}
            {canChangeCourse && student.status === "ACTIVE" ? (
              <LinkButton href={`/enrollment/course-change?studentId=${student.id}`} variant="secondary">
                Change course
              </LinkButton>
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
        <StatTile
          label="Paid"
          value={formatPaise(paid)}
          tone="success"
          hint={unappliedCredit > 0 ? `Includes ${formatPaise(unappliedCredit)} held as credit` : undefined}
        />
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

        {/* The fee structures these changes scrapped were deleted outright, so
            this is the only place left that says what they were. */}
        {courseChanges.length > 0 ? (
          <Card
            title="Course changes"
            description="Each one scrapped the fee assigned for the old course and re-applied everything collected to the new one."
          >
            <TableWrap>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>From → To</Th>
                  <Th className="text-right">Fee scrapped</Th>
                  <Th className="text-right">Fee assigned</Th>
                  <Th className="text-right">Payments carried</Th>
                  <Th>Reason</Th>
                  <Th>Changed by</Th>
                </tr>
              </thead>
              <tbody>
                {courseChanges.map((change) => (
                  <Tr key={change.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDate(change.changedAt)}</Td>
                    <Td>
                      {change.fromCourse.name} ({change.fromBatch.code})
                      {change.fromSemesterNumber ? ` · sem ${change.fromSemesterNumber}` : ""}
                      <span className="block text-xs text-muted">
                        → {change.toCourse.name} ({change.toBatch.code}) · sem {change.toSemesterNumber}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatPaise(change.scrappedTotalPayablePaise)}
                      <span className="block text-xs text-muted">
                        {change.scrappedInstallmentCount} installment(s)
                        {change.scrappedDiscountPaise > 0
                          ? `, ${formatPaise(change.scrappedDiscountPaise)} discounted`
                          : ""}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatPaise(change.newTotalPayablePaise)}
                      <span className="block text-xs text-muted">{change.newInstallmentCount} installment(s)</span>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatPaise(change.carriedPaidPaise)}
                      {change.unallocatedPaise > 0 ? (
                        <span className="block text-xs text-muted">
                          {formatPaise(change.unallocatedPaise)} held as credit
                        </span>
                      ) : null}
                      {change.releasedLateFeePaise > 0 ? (
                        <span className="block text-xs text-muted">
                          incl. {formatPaise(change.releasedLateFeePaise)} late fee credited
                        </span>
                      ) : null}
                    </Td>
                    <Td className="max-w-xs">{change.reason}</Td>
                    <Td className="text-muted">{change.changedBy?.name ?? "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>
        ) : null}

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

        {/* Silence here used to be indistinguishable from a student who owes
            nothing, which is how imported students went unbilled unnoticed. */}
        {student.feeAssignments.length === 0 ? (
          <Alert tone="warning" title="No fee has been assigned to this student">
            Nothing is charged for any semester, so this student appears nowhere in Fee Due, no reminder will reach them
            and there is nothing to collect against. A student who arrived by bulk import went through neither approval
            nor a promotion run, which is usually the reason.
            {canAssignFee ? " “Assign fee” above bills a semester." : null}
          </Alert>
        ) : gapSemesters.length > 0 ? (
          <Alert
            tone="warning"
            title={`Semester ${gapSemesters.map((semester) => semester.semesterNumber).join(", ")} carries no fee`}
          >
            The student has reached {currentSemesterNumber === 0 ? "this point" : `semester ${currentSemesterNumber}`}{" "}
            without anything being charged for{" "}
            {gapSemesters.length === 1 ? "that semester" : "those semesters"}, so none of it is collectible or visible
            in Fee Due. Semesters they have not reached yet are billed by the promotion run and are not counted here.
            {canAssignFee ? " “Assign fee” above fills the gap." : null}
          </Alert>
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
