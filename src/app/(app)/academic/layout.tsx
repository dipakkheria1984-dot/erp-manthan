import type { ReactNode } from "react";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { SubNav } from "@/components/sub-nav";

const TABS = [
  { label: "Departments", href: "/academic/departments" },
  { label: "Courses", href: "/academic/courses" },
  { label: "Batches", href: "/academic/batches" },
];

export default async function AcademicLayout({ children }: { children: ReactNode }) {
  await requirePermission(PERMISSIONS.ACADEMIC_VIEW, PERMISSIONS.ACADEMIC_MANAGE);
  return (
    <div>
      <SubNav tabs={TABS} />
      {children}
    </div>
  );
}
