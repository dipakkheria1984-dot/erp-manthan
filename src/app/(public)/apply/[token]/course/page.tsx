import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { applicationForToken } from "@/lib/applicant-portal";
import { CourseForm } from "./course-form";

export default async function PortalCoursePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await applicationForToken(token);
  if (!result.ok) notFound();

  // Only what is open to applicants — a discontinued course must not be
  // selectable from outside any more than it is from the wizard.
  const [departments, courses] = await Promise.all([
    prisma.department.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.course.findMany({
      where: { status: "ACTIVE", department: { status: "ACTIVE" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, departmentId: true },
    }),
  ]);

  return (
    <CourseForm
      token={token}
      departments={departments}
      courses={courses.map((course) => ({ id: course.id, name: course.name, parentId: course.departmentId }))}
      departmentId={result.application.departmentId}
      courseId={result.application.courseId}
    />
  );
}
