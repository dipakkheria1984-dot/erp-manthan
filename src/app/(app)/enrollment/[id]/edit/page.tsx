import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { Alert, LinkButton } from "@/components/ui";
import { StudentInfoForm } from "../../student-info-form";
import { StepFooter } from "../step-footer";

export const metadata = { title: "Student information" };

export default async function EditApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(PERMISSIONS.ENROLLMENT_CREATE, PERMISSIONS.ENROLLMENT_VIEW);
  const { id } = await params;
  const application = await prisma.application.findUnique({
    where: { id },
    include: { student: { select: { id: true, studentCode: true } } },
  });
  if (!application) notFound();

  const locked = application.status === "ENROLLED" || application.status === "REJECTED";

  const footer = (
    <StepFooter
      back={{ href: `/enrollment/${id}`, label: "Back to overview" }}
      next={{ href: `/enrollment/${id}/guardians`, label: "Continue to guardians" }}
    />
  );

  if (locked) {
    // An enrolled applicant is a live student, and their details still change —
    // that correction is made on the student record, which writes both copies.
    const student = application.student;
    const canEditProfile = student !== null && hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_CREATE);

    return (
      <div className="space-y-6">
        <Alert tone="info" title="Locked">
          This application is {application.status.toLowerCase()} and can no longer be edited here — what an admission was
          granted on stays as it was decided.
          {student
            ? " Personal, contact and previous-education details are corrected on the student record instead, which updates the admission form with them."
            : ""}
        </Alert>
        {canEditProfile ? (
          <LinkButton href={`/students/${student.id}/edit`}>Edit {student.studentCode}&apos;s profile</LinkButton>
        ) : null}
        {footer}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <StudentInfoForm
        submitLabel="Save changes"
        values={{
          id: application.id,
          fullName: application.fullName,
          gender: application.gender,
          dob: application.dob ? application.dob.toISOString() : null,
          bloodGroup: application.bloodGroup,
          addressLine1: application.addressLine1,
          addressLine2: application.addressLine2,
          city: application.city,
          state: application.state,
          pincode: application.pincode,
          phone: application.phone,
          email: application.email,
          nationalId: application.nationalId,
          previousEnrollmentNo: application.previousEnrollmentNo,
          previousInstitution: application.previousInstitution,
          previousQualification: application.previousQualification,
          previousMarks: application.previousMarks,
          hasTransferCertificate: application.hasTransferCertificate,
        }}
      />
      {footer}
    </div>
  );
}
