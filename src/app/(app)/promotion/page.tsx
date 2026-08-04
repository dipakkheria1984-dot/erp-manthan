import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { PERMISSIONS } from "@/lib/permissions";
import { balanceOf } from "@/lib/late-fees";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { Alert, Card, EmptyState, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { PromotionPicker } from "./promotion-picker";
import { PromotionRunner } from "./promotion-runner";

export const metadata = { title: "Promotion" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function PromotionPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePermission(PERMISSIONS.PROMOTION_RUN);
  const params = await searchParams;
  const batchId = one(params.batchId);
  const semesterId = one(params.semesterId);

  const [batches, config, slabs, recentRuns] = await Promise.all([
    prisma.batch.findMany({
      where: { status: { in: ["ONGOING", "UPCOMING"] } },
      include: { course: true, semesters: { orderBy: { semesterNumber: "asc" } } },
      orderBy: { name: "asc" },
    }),
    getConfig(),
    prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
    prisma.promotionRun.findMany({
      include: {
        batch: true,
        fromSemester: true,
        toSemester: true,
        runBy: { select: { name: true } },
      },
      orderBy: { runAt: "desc" },
      take: 10,
    }),
  ]);

  const batch = batchId ? batches.find((b) => b.id === batchId) : null;
  const fromSemester = batch && semesterId ? batch.semesters.find((s) => s.id === semesterId) : null;
  const toSemester =
    batch && fromSemester
      ? batch.semesters.find((s) => s.semesterNumber === fromSemester.semesterNumber + 1)
      : null;

  const candidates =
    batch && fromSemester
      ? await prisma.student.findMany({
          where: { batchId: batch.id, currentSemesterId: fromSemester.id, status: "ACTIVE" },
          include: {
            feeAssignments: { include: { installments: { include: { payments: true } } } },
            application: { select: { isProvisional: true } },
          },
          orderBy: { studentCode: "asc" },
        })
      : [];

  const preview = candidates.map((student) => {
    const outstanding = student.feeAssignments
      .flatMap((fa) => fa.installments)
      .reduce(
        (sum, installment) =>
          sum +
          balanceOf(installment, slabs, config, new Date(), student.application.isProvisional).totalOutstandingPaise,
        0,
      );
    return {
      id: student.id,
      studentCode: student.studentCode,
      fullName: student.fullName,
      hasBacklog: student.hasBacklog,
      outstandingPaise: outstanding,
    };
  });

  const crossesYear = Boolean(fromSemester && toSemester && toSemester.yearNumber > fromSemester.yearNumber);

  return (
    <>
      <PageHeader
        title="Promote students"
        description="Promotion is bulk by default: pick a batch and its current semester, review the cohort, then confirm. Pending dues never block a promotion."
      />

      <div className="space-y-6">
        <Card title="Select a cohort">
          <PromotionPicker
            batches={batches.map((b) => ({
              id: b.id,
              name: `${b.code} — ${b.name}`,
              semesters: b.semesters.map((s) => ({
                id: s.id,
                label: `Semester ${s.semesterNumber} (Year ${s.yearNumber})`,
              })),
            }))}
            selectedBatchId={batchId}
            selectedSemesterId={semesterId}
          />
        </Card>

        {batch && fromSemester && !toSemester ? (
          <Alert tone="warning" title="Final semester">
            Semester {fromSemester.semesterNumber} is the last of this course, so there is nothing to promote into.
          </Alert>
        ) : null}

        {batch && fromSemester && toSemester ? (
          <>
            <Alert tone={crossesYear ? "warning" : "info"} title="Fees for the new semester">
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>
                  Exam fee {formatPaise(toSemester.examFeePaise)} and activity fee{" "}
                  {formatPaise(toSemester.activityFeePaise)} apply at their current value — these are never rate-locked.
                </li>
                <li>
                  {crossesYear
                    ? `This promotion crosses into Year ${toSemester.yearNumber}, so tuition is re-applied at each student's locked Year 1 rate with no scholarship carried forward.`
                    : "This is a same-year promotion, so tuition is not re-charged."}
                </li>
                <li>Any unpaid balance stays tagged to its original semester and carries forward in the ledger.</li>
              </ul>
            </Alert>

            {preview.length === 0 ? (
              <EmptyState
                title="No active students in this semester"
                description="Dropped-out and expelled students are excluded from promotion runs automatically."
              />
            ) : (
              <PromotionRunner
                batchId={batch.id}
                fromSemesterId={fromSemester.id}
                toSemesterLabel={`Semester ${toSemester.semesterNumber} (Year ${toSemester.yearNumber})`}
                students={preview}
                installmentMin={config.installmentMin}
                installmentMax={config.installmentMax}
                completionDate={batch.completionDate.toISOString()}
              />
            )}
          </>
        ) : null}

        <Card title="Recent promotion runs">
          {recentRuns.length === 0 ? (
            <p className="text-sm text-muted">No promotions have been run yet.</p>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Batch</Th>
                  <Th>From → To</Th>
                  <Th className="text-right">Included</Th>
                  <Th className="text-right">Excluded</Th>
                  <Th>Run by</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <Tr key={run.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDateTime(run.runAt)}</Td>
                    <Td>{run.batch.name}</Td>
                    <Td>
                      Sem {run.fromSemester.semesterNumber} → {run.toSemester.semesterNumber}
                    </Td>
                    <Td className="text-right tabular-nums">{run.includedCount}</Td>
                    <Td className="text-right tabular-nums">{run.excludedCount}</Td>
                    <Td className="text-muted">{run.runBy?.name ?? "—"}</Td>
                    <Td className="max-w-xs text-muted">{run.notes ?? "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        {batch ? (
          <p className="text-xs text-muted">
            Batch completion date: {formatDate(batch.completionDate)} — every installment due date must fall on or
            before this.
          </p>
        ) : null}
      </div>
    </>
  );
}
