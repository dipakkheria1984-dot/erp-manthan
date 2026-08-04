import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { Alert } from "@/components/ui";
import { CourseSelectionForm } from "./course-selection-form";
import { StepFooter } from "../step-footer";

export const metadata = { title: "Course selection" };

export default async function CourseSelectionPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(PERMISSIONS.ENROLLMENT_VIEW);
  const { id } = await params;

  const application = await prisma.application.findUnique({ where: { id } });
  if (!application) notFound();

  const [academicYears, departments, courses, batches] = await Promise.all([
    prisma.academicYear.findMany({ orderBy: { startDate: "desc" } }),
    prisma.department.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.course.findMany({ where: { status: { not: "DISCONTINUED" } }, orderBy: { name: "asc" } }),
    prisma.batch.findMany({
      where: { status: { in: ["UPCOMING", "ONGOING"] } },
      include: { _count: { select: { students: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  const editable = ["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(application.status);

  const footer = (
    <StepFooter
      back={{ href: `/enrollment/${id}/guardians`, label: "Back to guardians" }}
      next={{ href: `/enrollment/${id}/documents`, label: "Continue to documents" }}
    />
  );

  if (!editable) {
    return (
      <div className="space-y-6">
        <Alert tone="info" title="Locked">
          Course and batch selection is fixed once an application is {application.status.toLowerCase()}.
        </Alert>
        {footer}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <CourseSelectionForm
        applicationId={id}
        values={{
          academicYearId: application.academicYearId,
          departmentId: application.departmentId,
          courseId: application.courseId,
          batchId: application.batchId,
          requestedScholarshipPercent: application.requestedScholarshipPercent,
          requestedScholarshipPaise: application.requestedScholarshipPaise,
          scholarshipNeedsApproval: application.scholarshipNeedsApproval,
        }}
        academicYears={academicYears.map((y) => ({ id: y.id, name: y.name, isCurrent: y.isCurrent }))}
        departments={departments.map((d) => ({ id: d.id, name: `${d.code} — ${d.name}` }))}
        courses={courses.map((c) => ({ id: c.id, name: `${c.code} — ${c.name}`, departmentId: c.departmentId }))}
        batches={batches.map((b) => ({
          id: b.id,
          name: `${b.code} — ${b.name}`,
          courseId: b.courseId,
          seatsLeft: b.totalSeats - b._count.students,
        }))}
      />
      {footer}
    </div>
  );
}
