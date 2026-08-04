import type { ReactNode } from "react";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { SubNav } from "@/components/sub-nav";

const TABS = [
  { label: "Staff accounts", href: "/users" },
  { label: "Roles", href: "/users/roles" },
  { label: "Audit trail", href: "/users/audit" },
];

export default async function UsersLayout({ children }: { children: ReactNode }) {
  await requirePermission(PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE, PERMISSIONS.ROLES_MANAGE, PERMISSIONS.AUDIT_VIEW);
  return (
    <div>
      <SubNav tabs={TABS} />
      {children}
    </div>
  );
}
