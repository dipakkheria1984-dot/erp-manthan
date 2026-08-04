import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { Badge, Card, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { RoleEditor, RoleRowActions } from "./role-editor";

export const metadata = { title: "Roles" };

export default async function RolesPage() {
  await requirePermission(PERMISSIONS.ROLES_MANAGE);
  const roles = await prisma.role.findMany({
    include: { _count: { select: { users: true } } },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="Admin, Registrar and Accountant are predefined. Create custom roles with any combination of module permissions."
        actions={<RoleEditor />}
      />

      <Card>
        <TableWrap>
          <thead>
            <tr>
              <Th>Role</Th>
              <Th>Description</Th>
              <Th className="text-right">Permissions</Th>
              <Th className="text-right">Staff</Th>
              <Th className="w-40" />
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <Tr key={role.id}>
                <Td>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{role.name}</span>
                    {role.isSystem ? <Badge tone="info">Predefined</Badge> : <Badge>Custom</Badge>}
                  </div>
                </Td>
                <Td className="max-w-md text-muted">{role.description ?? "—"}</Td>
                <Td className="text-right tabular-nums">{role.permissions.length}</Td>
                <Td className="text-right tabular-nums">{role._count.users}</Td>
                <Td>
                  <RoleRowActions
                    role={{
                      id: role.id,
                      name: role.name,
                      description: role.description,
                      isSystem: role.isSystem,
                      permissions: role.permissions,
                      userCount: role._count.users,
                    }}
                  />
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableWrap>
      </Card>
    </>
  );
}
