import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { formatDateTime } from "@/lib/dates";
import { Badge, Card, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { UserEditor, UserRowActions } from "./user-editor";

export const metadata = { title: "Staff accounts" };

export default async function UsersPage() {
  const actor = await requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE);
  const canManage = hasPermission(actor.permissions, PERMISSIONS.USERS_MANAGE);

  const [users, roles, departments] = await Promise.all([
    prisma.user.findMany({
      include: { role: true, department: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.role.findMany({ orderBy: { name: "asc" } }),
    prisma.department.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
  ]);

  const roleOptions = roles.map((r) => ({ id: r.id, name: r.name }));
  const departmentOptions = departments.map((d) => ({ id: d.id, name: d.name }));
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Staff accounts"
        description="Accounts are created with a temporary password and a forced reset on first sign-in."
        actions={canManage ? <UserEditor roles={roleOptions} departments={departmentOptions} /> : null}
      />

      <Card>
        <TableWrap>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Employee ID</Th>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Department</Th>
              <Th>Status</Th>
              <Th>Last sign-in</Th>
              {canManage ? <Th className="w-56" /> : null}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const locked = user.lockedUntil && user.lockedUntil > now;
              return (
                <Tr key={user.id}>
                  <Td className="font-medium">{user.name}</Td>
                  <Td className="font-mono text-xs">{user.employeeId}</Td>
                  <Td>{user.email}</Td>
                  <Td>{user.role.name}</Td>
                  <Td>{user.department?.name ?? "—"}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {user.status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>}
                      {locked ? <Badge tone="warning">Locked</Badge> : null}
                      {user.mustResetPassword ? <Badge tone="info">Reset pending</Badge> : null}
                    </div>
                  </Td>
                  <Td className="text-muted">{formatDateTime(user.lastLoginAt)}</Td>
                  {canManage ? (
                    <Td>
                      <UserRowActions
                        user={{
                          id: user.id,
                          name: user.name,
                          employeeId: user.employeeId,
                          email: user.email,
                          phone: user.phone,
                          roleId: user.roleId,
                          departmentId: user.departmentId,
                          status: user.status,
                        }}
                        locked={Boolean(locked)}
                        roles={roleOptions}
                        departments={departmentOptions}
                      />
                    </Td>
                  ) : null}
                </Tr>
              );
            })}
          </tbody>
        </TableWrap>
      </Card>
    </>
  );
}
