import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { formatDate } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { Alert, Badge, Card, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { BatchEditor } from "./batch-editor";

export const metadata = { title: "Batches" };

const STATUS_TONE = { UPCOMING: "info", ONGOING: "success", COMPLETED: "neutral", DISCONTINUED: "warning" } as const;

export default async function BatchesPage() {
  const actor = await requirePermission(PERMISSIONS.ACADEMIC_VIEW, PERMISSIONS.ACADEMIC_MANAGE);
  const canManage = hasPermission(actor.permissions, PERMISSIONS.ACADEMIC_MANAGE);

  const [batches, courses] = await Promise.all([
    prisma.batch.findMany({
      include: {
        course: { include: { department: true } },
        feeHistory: { orderBy: { effectiveFrom: "desc" }, take: 1 },
        _count: { select: { students: true, semesters: true } },
      },
      orderBy: [{ status: "asc" }, { startDate: "desc" }],
    }),
    // Discontinued courses cannot receive new batches (spec 5.2).
    prisma.course.findMany({ where: { status: { not: "DISCONTINUED" } }, orderBy: { name: "asc" } }),
  ]);

  const courseOptions = courses.map((c) => ({ id: c.id, name: `${c.code} — ${c.name}` }));

  return (
    <>
      <PageHeader
        title="Batches"
        description="A batch is a fixed cohort — the same students move together through every semester. Enrollment is blocked once capacity is reached; there is no waitlist."
        actions={canManage && courseOptions.length > 0 ? <BatchEditor courses={courseOptions} /> : null}
      />

      {courseOptions.length === 0 ? (
        <div className="mb-4">
          <Alert tone="warning" title="No eligible courses">
            Create an active course before adding batches.
          </Alert>
        </div>
      ) : null}

      <Card>
        <TableWrap>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Batch</Th>
              <Th>Course</Th>
              <Th>Runs</Th>
              <Th className="text-right">Current fee</Th>
              <Th className="text-right">Seats</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 ? (
              <tr>
                <Td colSpan={7} className="text-center text-muted">
                  No batches yet.
                </Td>
              </tr>
            ) : (
              batches.map((batch) => {
                const seatsLeft = batch.totalSeats - batch._count.students;
                return (
                  <Tr key={batch.id}>
                    <Td className="font-mono text-xs">{batch.code}</Td>
                    <Td>
                      <Link href={`/academic/batches/${batch.id}`} className="font-medium text-brand hover:underline">
                        {batch.name}
                      </Link>
                      <p className="text-xs text-muted">{batch._count.semesters} semesters</p>
                    </Td>
                    <Td>
                      {batch.course.name}
                      <p className="text-xs text-muted">{batch.course.department.name}</p>
                    </Td>
                    <Td className="whitespace-nowrap text-muted">
                      {formatDate(batch.startDate)} → {formatDate(batch.completionDate)}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {batch.feeHistory[0] ? formatPaise(batch.feeHistory[0].tuitionFeePaise) : "—"}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {batch._count.students}/{batch.totalSeats}
                      {seatsLeft <= 0 ? <span className="ml-1 text-xs text-danger">full</span> : null}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[batch.status]}>
                        {batch.status.charAt(0) + batch.status.slice(1).toLowerCase()}
                      </Badge>
                    </Td>
                  </Tr>
                );
              })
            )}
          </tbody>
        </TableWrap>
      </Card>
    </>
  );
}
