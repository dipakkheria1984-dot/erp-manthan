import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { balanceOf, overdueBucket, waivableLateFeePaise } from "@/lib/late-fees";
import { formatDate } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { INSTALLMENT_STATUS_TONE, installmentStatusLabel } from "@/lib/students";
import { Alert, Badge, Card, EmptyState, PageHeader, StatTile, TableWrap, Td, Th, Tr } from "@/components/ui";
import { WaiveLateFeeButton } from "@/components/waive-late-fee-button";
import { StudentSearch } from "./student-search";
import { PaymentForm } from "./payment-form";

export const metadata = { title: "Collect fees" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function CollectFeesPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await requirePermission(PERMISSIONS.FEE_COLLECT);
  // Waiving a late fee is a counter decision, so it belongs on this screen for
  // whoever is issuing the receipt (Accountant or Admin).
  const canWaiveLateFee = hasPermission(actor.permissions, PERMISSIONS.FEE_WAIVE_LATE_FEE);
  const params = await searchParams;
  const q = one(params.q);
  const studentId = one(params.studentId);

  const [config, slabs] = await Promise.all([
    getConfig(),
    prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
  ]);

  const matches = q
    ? await prisma.student.findMany({
        where: {
          OR: [
            { fullName: { contains: q, mode: "insensitive" } },
            { studentCode: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
          ],
        },
        include: { batch: true, course: true },
        take: 20,
      })
    : [];

  const student = studentId
    ? await prisma.student.findUnique({
        where: { id: studentId },
        include: {
          batch: true,
          course: true,
          department: true,
          application: { select: { isProvisional: true } },
          feeAssignments: {
            include: {
              semester: true,
              installments: { orderBy: { seqNo: "asc" }, include: { payments: true } },
            },
            orderBy: [{ yearNumber: "asc" }, { createdAt: "asc" }],
          },
        },
      })
    : null;

  // No late fee accrues while the admission is provisional — the registration
  // fee has not been cleared, so the admission is not confirmed.
  const lateFeeExempt = student?.application.isProvisional ?? false;

  const rows =
    student?.feeAssignments.flatMap((assignment) =>
      assignment.installments.map((installment) => ({
        assignment,
        installment,
        balance: balanceOf(installment, slabs, config, new Date(), lateFeeExempt),
      })),
    ) ?? [];

  const totalOutstanding = rows.reduce((sum, row) => sum + row.balance.totalOutstandingPaise, 0);
  const totalLateFee = rows.reduce((sum, row) => sum + row.balance.lateFeeOutstandingPaise, 0);
  // FIFO: the collection form applies money oldest due date first.
  const payable = rows
    .filter((row) => row.balance.totalOutstandingPaise > 0 && row.installment.status !== "WAIVED")
    .sort(
      (a, b) =>
        a.installment.dueDate.getTime() - b.installment.dueDate.getTime() || a.installment.seqNo - b.installment.seqNo,
    );

  return (
    <>
      <PageHeader
        title="Collect fees"
        description="Record what the student pays. The amount is applied to installments oldest due date first (FIFO) — it can settle several at once, or part of one."
      />

      <div className="space-y-6">
        <Card title="Find a student">
          <StudentSearch defaultQuery={q} />
          {q && matches.length > 0 ? (
            <div className="mt-4">
              <TableWrap>
                <thead>
                  <tr>
                    <Th>Student ID</Th>
                    <Th>Name</Th>
                    <Th>Course</Th>
                    <Th>Batch</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((match) => (
                    <Tr key={match.id}>
                      <Td>
                        <Link
                          href={`/fees/collect?studentId=${match.id}`}
                          className="font-mono text-xs text-brand hover:underline"
                        >
                          {match.studentCode}
                        </Link>
                      </Td>
                      <Td className="font-medium">{match.fullName}</Td>
                      <Td>{match.course.name}</Td>
                      <Td>{match.batch.name}</Td>
                      <Td>{match.status.replaceAll("_", "-").toLowerCase()}</Td>
                    </Tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
          ) : null}
          {q && matches.length === 0 ? <p className="mt-4 text-sm text-muted">No students matched “{q}”.</p> : null}
        </Card>

        {student ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Student" value={student.studentCode} hint={student.fullName} />
              <StatTile label="Batch" value={student.batch.name} hint={student.course.name} />
              <StatTile
                label="Outstanding"
                value={formatPaise(totalOutstanding)}
                tone={totalOutstanding > 0 ? "danger" : "success"}
              />
              <StatTile
                label="Late fee accrued"
                value={formatPaise(totalLateFee)}
                tone={totalLateFee > 0 ? "warning" : "default"}
              />
            </div>

            {lateFeeExempt ? (
              <Alert tone="info" title="Provisional admission — no late fee is accruing">
                The registration fee has not been cleared, so the admission is not confirmed and no late fee applies.
                Late fees start only once the registration fee is settled and the admission is confirmed.
              </Alert>
            ) : null}

            {student.status !== "ACTIVE" && student.status !== "PASSED" ? (
              <Alert tone="warning" title={`This student is ${student.status.replaceAll("_", "-").toLowerCase()}`}>
                Pending installments were waived when the status changed. Reinstate the student to collect fees again.
              </Alert>
            ) : null}

            <Card title="Installments">
              {rows.length === 0 ? (
                <EmptyState title="No fees assigned yet." />
              ) : (
                <TableWrap>
                  <thead>
                    <tr>
                      <Th>Semester</Th>
                      <Th className="w-14">#</Th>
                      <Th>Due date</Th>
                      <Th className="text-right">Amount</Th>
                      <Th className="text-right">Paid</Th>
                      <Th className="text-right">Late fee</Th>
                      <Th className="text-right">Outstanding</Th>
                      <Th>Status</Th>
                      {canWaiveLateFee ? <Th className="w-32" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ assignment, installment, balance }) => (
                      <Tr key={installment.id}>
                        <Td>
                          Sem {assignment.semester.semesterNumber}
                          {/* Charges raised after enrollment say what they are for. */}
                          {installment.extraChargeKind ? (
                            <span className="block text-xs text-muted">{installment.label ?? "Extra charge"}</span>
                          ) : null}
                        </Td>
                        <Td className="tabular-nums">{installment.seqNo}</Td>
                        <Td className="whitespace-nowrap">
                          {formatDate(installment.dueDate)}
                          {balance.daysOverdue > 0 ? (
                            <p className="text-xs text-danger">
                              {balance.daysOverdue}d overdue ({overdueBucket(balance.daysOverdue)})
                            </p>
                          ) : null}
                        </Td>
                        <Td className="text-right tabular-nums">{formatPaise(installment.amountPaise)}</Td>
                        <Td className="text-right tabular-nums">{formatPaise(balance.principalPaidPaise)}</Td>
                        <Td className="text-right tabular-nums">
                          {balance.lateFeeOutstandingPaise > 0 ? (
                            <span className="text-danger">{formatPaise(balance.lateFeeOutstandingPaise)}</span>
                          ) : balance.lateFeeWaivedPaise > 0 || installment.lateFeeWaived ? (
                            <span className="text-xs text-muted">Waived</span>
                          ) : (
                            "—"
                          )}
                          {balance.lateFeeWaivedPaise > 0 && balance.lateFeeOutstandingPaise > 0 ? (
                            <span className="block text-xs text-muted">
                              {formatPaise(balance.lateFeeWaivedPaise)} waived
                            </span>
                          ) : null}
                        </Td>
                        <Td className="text-right font-medium tabular-nums">
                          {formatPaise(balance.totalOutstandingPaise)}
                        </Td>
                        <Td>
                          <Badge tone={INSTALLMENT_STATUS_TONE[installment.status]}>
                            {installmentStatusLabel(installment.status)}
                          </Badge>
                        </Td>
                        {canWaiveLateFee ? (
                          <Td>
                            {(() => {
                              // A late fee already collected can still be waived —
                              // it is credited against what is owed next.
                              const lateFee = waivableLateFeePaise({
                                assessedPaise: balance.lateFeeAssessedPaise,
                                waivedPaise: balance.lateFeeWaivedPaise,
                                paidPaise: balance.lateFeePaidPaise,
                                creditedPaise: installment.lateFeeCreditedPaise,
                              });
                              if (lateFee.totalPaise <= 0) return null;
                              return (
                                <WaiveLateFeeButton
                                  installmentId={installment.id}
                                  outstandingLateFeeLabel={formatPaise(lateFee.totalPaise)}
                                  collectedLateFeeLabel={
                                    lateFee.collectedPaise > 0 ? formatPaise(lateFee.collectedPaise) : undefined
                                  }
                                />
                              );
                            })()}
                          </Td>
                        ) : null}
                      </Tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </Card>

            {payable.length > 0 && (student.status === "ACTIVE" || student.status === "PASSED") ? (
              <Card
                title="Record a payment"
                description="Enter the amount received. It is applied to the oldest due installment first and carries on to the next, so one payment can clear several installments."
              >
                <PaymentForm
                  studentId={student.id}
                  installments={payable.map(({ assignment, installment, balance }) => ({
                    id: installment.id,
                    label: installment.extraChargeKind
                      ? `Sem ${assignment.semester.semesterNumber} · ${installment.label ?? "Extra charge"}`
                      : `Sem ${assignment.semester.semesterNumber} · Installment ${installment.seqNo}`,
                    dueLabel: formatDate(installment.dueDate),
                    outstandingPaise: balance.totalOutstandingPaise,
                    lateFeeOutstandingPaise: balance.lateFeeOutstandingPaise,
                  }))}
                />
              </Card>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
