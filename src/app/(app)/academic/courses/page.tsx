import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { Alert, Badge, Card, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { getConfig } from "@/lib/config";
import { formatPaise } from "@/lib/money";
import { courseRegistrationFee } from "@/lib/fees";
import { CourseEditor, CourseRowActions } from "./course-editor";

export const metadata = { title: "Courses" };

const STATUS_TONE = { ACTIVE: "success", INACTIVE: "danger", DISCONTINUED: "warning" } as const;

export default async function CoursesPage() {
  const actor = await requirePermission(PERMISSIONS.ACADEMIC_VIEW, PERMISSIONS.ACADEMIC_MANAGE);
  const canManage = hasPermission(actor.permissions, PERMISSIONS.ACADEMIC_MANAGE);

  const [courses, departments, config] = await Promise.all([
    prisma.course.findMany({
      include: { department: true, _count: { select: { batches: true, students: true } } },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.department.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
    getConfig(),
  ]);

  const departmentOptions = departments.map((d) => ({ id: d.id, name: `${d.code} — ${d.name}` }));

  return (
    <>
      <PageHeader
        title="Courses"
        description="Every course runs at least two semesters. Discontinued courses keep their existing batches but accept no new ones."
        actions={
          canManage && departmentOptions.length > 0 ? (
            <CourseEditor
              departments={departmentOptions}
              minRegistrationFeePaise={config.minRegistrationFeePaise}
            />
          ) : null
        }
      />

      {departmentOptions.length === 0 ? (
        <div className="mb-4">
          <Alert tone="warning" title="No active departments">
            Create a department before adding courses.
          </Alert>
        </div>
      ) : null}

      <Card>
        <TableWrap>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Department</Th>
              <Th className="text-right">Years</Th>
              <Th className="text-right">Semesters</Th>
              <Th className="text-right">Registration fee</Th>
              <Th className="text-right">Batches</Th>
              <Th className="text-right">Students</Th>
              <Th>Status</Th>
              {canManage ? <Th className="w-40" /> : null}
            </tr>
          </thead>
          <tbody>
            {courses.length === 0 ? (
              <tr>
                <Td colSpan={canManage ? 10 : 9} className="text-center text-muted">
                  No courses yet.
                </Td>
              </tr>
            ) : (
              courses.map((course) => (
                <Tr key={course.id}>
                  <Td className="font-mono text-xs">{course.code}</Td>
                  <Td className="font-medium">{course.name}</Td>
                  <Td>{course.department.name}</Td>
                  <Td className="text-right tabular-nums">{course.durationYears}</Td>
                  <Td className="text-right tabular-nums">{course.totalSemesters}</Td>
                  <Td className="text-right tabular-nums">
                    {formatPaise(courseRegistrationFee(course, config))}
                    {course.registrationFeePaise === null ? (
                      <span className="block text-xs text-muted">institute minimum</span>
                    ) : null}
                  </Td>
                  <Td className="text-right tabular-nums">{course._count.batches}</Td>
                  <Td className="text-right tabular-nums">{course._count.students}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[course.status]}>
                      {course.status.charAt(0) + course.status.slice(1).toLowerCase()}
                    </Badge>
                  </Td>
                  {canManage ? (
                    <Td>
                      <CourseRowActions
                        course={{
                          id: course.id,
                          name: course.name,
                          code: course.code,
                          departmentId: course.departmentId,
                          durationYears: course.durationYears,
                          totalSemesters: course.totalSemesters,
                          registrationFeePaise: course.registrationFeePaise,
                          status: course.status,
                        }}
                        departments={departmentOptions}
                        semesterCountLocked={course._count.batches > 0}
                        canDelete={course._count.batches === 0 && course._count.students === 0}
                        minRegistrationFeePaise={config.minRegistrationFeePaise}
                      />
                    </Td>
                  ) : null}
                </Tr>
              ))
            )}
          </tbody>
        </TableWrap>
      </Card>
    </>
  );
}
