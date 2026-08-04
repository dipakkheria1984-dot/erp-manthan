import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { formatDate } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { Badge, Card, DescriptionList, PageHeader, StatTile, TableWrap, Td, Th, Tr } from "@/components/ui";
import { BatchRowActions } from "../batch-editor";
import { FeeRevisionForm, SemesterRowActions } from "./batch-detail-forms";

export const metadata = { title: "Batch detail" };

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requirePermission(PERMISSIONS.ACADEMIC_VIEW, PERMISSIONS.ACADEMIC_MANAGE);
  const canManage = hasPermission(actor.permissions, PERMISSIONS.ACADEMIC_MANAGE);

  const batch = await prisma.batch.findUnique({
    where: { id },
    include: {
      course: { include: { department: true } },
      feeHistory: { orderBy: { effectiveFrom: "desc" }, include: { createdBy: { select: { name: true } } } },
      semesters: { orderBy: { semesterNumber: "asc" }, include: { academicYear: true } },
      _count: { select: { students: true, applications: true } },
    },
  });
  if (!batch) notFound();

  const [courses, academicYears] = await Promise.all([
    prisma.course.findMany({ where: { status: { not: "DISCONTINUED" } }, orderBy: { name: "asc" } }),
    prisma.academicYear.findMany({ orderBy: { startDate: "desc" } }),
  ]);

  const currentFee = batch.feeHistory[0]?.tuitionFeePaise ?? 0;
  const seatsLeft = batch.totalSeats - batch._count.students;

  return (
    <>
      <PageHeader
        title={batch.name}
        description={`${batch.course.code} — ${batch.course.name} · ${batch.course.department.name}`}
        actions={
          canManage ? (
            <BatchRowActions
              batch={{
                id: batch.id,
                name: batch.name,
                code: batch.code,
                courseId: batch.courseId,
                startDate: batch.startDate.toISOString(),
                completionDate: batch.completionDate.toISOString(),
                totalSeats: batch.totalSeats,
                currentFeePaise: currentFee,
                status: batch.status,
              }}
              courses={courses.map((c) => ({ id: c.id, name: `${c.code} — ${c.name}` }))}
              canDelete={batch._count.students === 0 && batch._count.applications === 0}
            />
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Current preset fee" value={formatPaise(currentFee)} hint="Tuition, before scholarship" />
        <StatTile
          label="Seats"
          value={`${batch._count.students}/${batch.totalSeats}`}
          hint={seatsLeft > 0 ? `${seatsLeft} available` : "Full — enrollment blocked"}
          tone={seatsLeft > 0 ? "default" : "danger"}
        />
        <StatTile label="Semesters" value={batch.semesters.length} />
        <StatTile label="Status" value={batch.status.charAt(0) + batch.status.slice(1).toLowerCase()} />
      </div>

      <div className="space-y-6">
        <Card title="Batch details">
          <DescriptionList
            items={[
              { label: "Code", value: batch.code },
              { label: "Course duration", value: `${batch.course.durationYears} years` },
              { label: "Start date", value: formatDate(batch.startDate) },
              { label: "Batch completion date", value: formatDate(batch.completionDate) },
              { label: "Applications", value: batch._count.applications },
              { label: "Enrolled students", value: batch._count.students },
            ]}
          />
        </Card>

        <Card
          title="Semesters"
          description="Exam and activity fees are not rate-locked — they apply at their current value for the academic year, whenever the student reaches that semester."
        >
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-16">#</Th>
                <Th>Year</Th>
                <Th>Runs</Th>
                <Th>Academic year</Th>
                <Th className="text-right">Exam fee</Th>
                <Th className="text-right">Activity fee</Th>
                {canManage ? <Th className="w-24" /> : null}
              </tr>
            </thead>
            <tbody>
              {batch.semesters.map((semester) => (
                <Tr key={semester.id}>
                  <Td className="tabular-nums font-medium">{semester.semesterNumber}</Td>
                  <Td>Year {semester.yearNumber}</Td>
                  <Td className="whitespace-nowrap text-muted">
                    {formatDate(semester.startDate)} → {formatDate(semester.endDate)}
                  </Td>
                  <Td>{semester.academicYear?.name ?? <span className="text-muted">Not set</span>}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(semester.examFeePaise)}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(semester.activityFeePaise)}</Td>
                  {canManage ? (
                    <Td>
                      <SemesterRowActions
                        semester={{
                          id: semester.id,
                          semesterNumber: semester.semesterNumber,
                          startDate: semester.startDate.toISOString(),
                          endDate: semester.endDate.toISOString(),
                          examFeePaise: semester.examFeePaise,
                          activityFeePaise: semester.activityFeePaise,
                          academicYearId: semester.academicYearId,
                        }}
                        academicYears={academicYears.map((y) => ({ id: y.id, name: y.name }))}
                      />
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>

        <Card
          title="Tuition fee history"
          description="Each revision is a new version. A student's tuition rate is locked to the version effective on their enrollment date and stays there for every subsequent year."
        >
          <TableWrap>
            <thead>
              <tr>
                <Th>Effective from</Th>
                <Th className="text-right">Tuition fee</Th>
                <Th>Note</Th>
                <Th>Recorded by</Th>
                <Th className="w-24">Applies</Th>
              </tr>
            </thead>
            <tbody>
              {batch.feeHistory.map((row, index) => (
                <Tr key={row.id}>
                  <Td className="whitespace-nowrap">{formatDate(row.effectiveFrom)}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(row.tuitionFeePaise)}</Td>
                  <Td className="text-muted">{row.note ?? "—"}</Td>
                  <Td className="text-muted">{row.createdBy?.name ?? "System"}</Td>
                  <Td>{index === 0 ? <Badge tone="success">Current</Badge> : <Badge>Superseded</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </TableWrap>

          {canManage ? (
            <div className="mt-6 border-t border-border pt-5">
              <h3 className="mb-3 text-sm font-semibold">Record a fee revision</h3>
              <FeeRevisionForm batchId={batch.id} />
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
