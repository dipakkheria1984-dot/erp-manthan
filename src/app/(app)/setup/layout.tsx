import type { ReactNode } from "react";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { SubNav } from "@/components/sub-nav";

const TABS = [
  { label: "Institute profile", href: "/setup" },
  { label: "Printed material", href: "/setup/printing" },
  { label: "Global configuration", href: "/setup/config" },
  { label: "Late fee slabs", href: "/setup/late-fees" },
  { label: "Communication", href: "/setup/communication" },
  { label: "Academic years", href: "/setup/academic-years" },
  { label: "Document checklist", href: "/setup/documents" },
  { label: "Terms & conditions", href: "/setup/terms" },
];

export default async function SetupLayout({ children }: { children: ReactNode }) {
  await requirePermission(PERMISSIONS.INSTITUTE_MANAGE, PERMISSIONS.TERMS_MANAGE);
  return (
    <div>
      <SubNav tabs={TABS} />
      {children}
    </div>
  );
}
