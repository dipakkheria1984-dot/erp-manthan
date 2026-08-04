import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { Badge, Card, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { DepartmentEditor, DepartmentRowActions } from "./department-editor";

export const metadata = { title: "Departments" };

export default async function DepartmentsPage() {
  const actor = await requirePermission(PERMISSIONS.ACADEMIC_VIEW, PERMISSIONS.ACADEMIC_MANAGE);
  const canManage = hasPermission(actor.permissions, PERMISSIONS.ACADEMIC_MANAGE);

  const departments = await prisma.department.findMany({
    include: { _count: { select: { courses: true, students: true } } },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });

  return (
    <>
      <PageHeader
        title="Departments"
        description="Top level of the academic hierarchy: Department → Course → Batch → Semester."
        actions={canManage ? <DepartmentEditor /> : null}
      />
      <Card>
        <TableWrap>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Head of department</Th>
              <Th className="text-right">Courses</Th>
              <Th className="text-right">Students</Th>
              <Th>Status</Th>
              {canManage ? <Th className="w-40" /> : null}
            </tr>
          </thead>
          <tbody>
            {departments.length === 0 ? (
              <tr>
                <Td colSpan={canManage ? 7 : 6} className="text-center text-muted">
                  No departments yet.
                </Td>
              </tr>
            ) : (
              departments.map((dept) => (
                <Tr key={dept.id}>
                  <Td className="font-mono text-xs">{dept.code}</Td>
                  <Td className="font-medium">{dept.name}</Td>
                  <Td>{dept.headOfDepartment ?? "—"}</Td>
                  <Td className="text-right tabular-nums">{dept._count.courses}</Td>
                  <Td className="text-right tabular-nums">{dept._count.students}</Td>
                  <Td>
                    {dept.status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>}
                  </Td>
                  {canManage ? (
                    <Td>
                      <DepartmentRowActions
                        department={{
                          id: dept.id,
                          name: dept.name,
                          code: dept.code,
                          headOfDepartment: dept.headOfDepartment,
                          status: dept.status,
                        }}
                        canDelete={dept._count.courses === 0 && dept._count.students === 0}
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
