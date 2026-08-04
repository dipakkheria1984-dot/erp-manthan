import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { formatDate } from "@/lib/dates";
import { STUDENT_STATUS_TONE, studentStatusLabel } from "@/lib/students";
import { Badge, Card, LinkButton, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { StudentFilters } from "./student-filters";
import type { StudentStatus } from "@/generated/prisma/client";

export const metadata = { title: "Students" };

const PAGE_SIZE = 25;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function StudentsPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePermission(PERMISSIONS.STUDENT_VIEW);
  const params = await searchParams;

  const q = one(params.q);
  const status = one(params.status);
  const batchId = one(params.batchId);
  const page = Math.max(1, Number.parseInt(one(params.page) || "1", 10) || 1);

  // Dropped-out and expelled students are excluded by default and only appear
  // when explicitly filtered for (spec 4.5 / 7).
  const where = {
    ...(status ? { status: status as StudentStatus } : { status: { in: ["ACTIVE", "PASSED"] as StudentStatus[] } }),
    ...(batchId ? { batchId } : {}),
    ...(q
      ? {
          OR: [
            { fullName: { contains: q, mode: "insensitive" as const } },
            { studentCode: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
          ],
        }
      : {}),
  };

  const [students, total, batches] = await Promise.all([
    prisma.student.findMany({
      where,
      include: { batch: true, course: true, department: true, currentSemester: true },
      orderBy: { studentCode: "asc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.student.count({ where }),
    prisma.batch.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (next: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, status, batchId })) if (v) sp.set(k, v);
    sp.set("page", String(next));
    return `/students?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Students"
        description="Dropped-out and expelled students are hidden unless you filter for them explicitly."
      />

      <div className="space-y-4">
        <Card>
          <StudentFilters
            batches={batches.map((b) => ({ id: b.id, name: `${b.code} — ${b.name}` }))}
            defaults={{ q, status, batchId }}
          />
        </Card>

        <Card title={`${total.toLocaleString("en-IN")} student${total === 1 ? "" : "s"}`}>
          <TableWrap>
            <thead>
              <tr>
                <Th>Student ID</Th>
                <Th>Name</Th>
                <Th>Department</Th>
                <Th>Course</Th>
                <Th>Batch</Th>
                <Th>Semester</Th>
                <Th>Enrolled</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {students.length === 0 ? (
                <tr>
                  <Td colSpan={8} className="text-center text-muted">
                    No students match these filters.
                  </Td>
                </tr>
              ) : (
                students.map((student) => (
                  <Tr key={student.id}>
                    <Td>
                      <Link href={`/students/${student.id}`} className="font-mono text-xs text-brand hover:underline">
                        {student.studentCode}
                      </Link>
                    </Td>
                    <Td className="font-medium">{student.fullName}</Td>
                    <Td>{student.department.name}</Td>
                    <Td>{student.course.name}</Td>
                    <Td>{student.batch.name}</Td>
                    <Td className="tabular-nums">{student.currentSemester?.semesterNumber ?? "—"}</Td>
                    <Td className="whitespace-nowrap text-muted">{formatDate(student.enrollmentDate)}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={STUDENT_STATUS_TONE[student.status]}>{studentStatusLabel(student.status)}</Badge>
                        {student.hasBacklog ? <Badge tone="warning">Backlog</Badge> : null}
                      </div>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </TableWrap>

          {totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between">
              <LinkButton href={pageHref(Math.max(1, page - 1))} variant="secondary" size="sm">
                Previous
              </LinkButton>
              <span className="text-sm text-muted">
                Page {page} of {totalPages}
              </span>
              <LinkButton href={pageHref(Math.min(totalPages, page + 1))} variant="secondary" size="sm">
                Next
              </LinkButton>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
