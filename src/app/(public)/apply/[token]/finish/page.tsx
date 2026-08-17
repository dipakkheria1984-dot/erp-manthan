import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { applicationForToken } from "@/lib/applicant-portal";
import { Alert, Card, DescriptionList } from "@/components/ui";
import { FinishForm } from "./finish-form";

/**
 * The last step. Shows what is still missing before the form can go in, and
 * says plainly what happens next — the fee conversation is the office's, and an
 * applicant who expects to pay here would otherwise be left hanging.
 */
export default async function PortalFinishPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await applicationForToken(token);
  if (!result.ok) notFound();

  const application = result.application;

  const [guardianCount, documents, requirements, department, course] = await Promise.all([
    prisma.guardian.count({ where: { applicationId: application.id } }),
    prisma.applicationDocument.findMany({
      where: { applicationId: application.id },
      select: { requirementCode: true },
    }),
    prisma.documentRequirement.findMany({ where: { isActive: true, isRequired: true } }),
    application.departmentId
      ? prisma.department.findUnique({ where: { id: application.departmentId }, select: { name: true } })
      : null,
    application.courseId
      ? prisma.course.findUnique({ where: { id: application.courseId }, select: { name: true } })
      : null,
  ]);

  const uploaded = new Set(documents.map((document) => document.requirementCode));
  const missingDocuments = requirements.filter((requirement) => !uploaded.has(requirement.code));

  // Mirrors the check in `finishPortalApplicationAction`. Shown here so the
  // applicant can fix it, enforced there so it cannot be skipped.
  const missing = [
    application.courseId ? null : "Choose your department and course",
    guardianCount > 0 ? null : "Add at least one parent or guardian",
    ...missingDocuments.map((requirement) => `Upload your ${requirement.label}`),
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-6">
      <Card title="Check your answers">
        <DescriptionList
          items={[
            { label: "Name", value: application.fullName },
            { label: "Phone", value: application.phone || "—" },
            { label: "Email", value: application.email || "—" },
            { label: "Department", value: department?.name ?? "Not chosen yet" },
            { label: "Course", value: course?.name ?? "Not chosen yet" },
            { label: "Parents / guardians", value: `${guardianCount} added` },
            { label: "Documents uploaded", value: `${documents.length}` },
          ]}
        />
      </Card>

      {missing.length > 0 ? (
        <Alert tone="warning" title="Still to do">
          <ul className="list-disc space-y-0.5 pl-5">
            {missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <Alert tone="info" title="What happens next">
          Once you send this in, you will not be able to change it. The admissions office will check your
          documents, place you in a batch, and contact you about the course fees and how to pay them.
        </Alert>
      )}

      <FinishForm token={token} ready={missing.length === 0} />
    </div>
  );
}
