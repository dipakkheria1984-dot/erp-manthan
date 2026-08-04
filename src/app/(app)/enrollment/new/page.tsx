import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader } from "@/components/ui";
import { StudentInfoForm } from "../student-info-form";

export const metadata = { title: "New application" };

export default async function NewApplicationPage() {
  await requirePermission(PERMISSIONS.ENROLLMENT_CREATE);
  return (
    <>
      <PageHeader
        title="New application"
        description="Step 1 of 6 — student information. Saving creates a draft; the remaining steps follow."
      />
      <StudentInfoForm submitLabel="Save and continue" />
    </>
  );
}
