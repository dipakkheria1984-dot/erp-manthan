import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { Alert, LinkButton, PageHeader } from "@/components/ui";
import { StudentInfoForm } from "../../../enrollment/student-info-form";
import { updateStudentProfileAction } from "../../actions";

export const metadata = { title: "Edit student profile" };

/**
 * The admission form of an enrolled student, reopened for correction.
 *
 * The enrollment wizard locks an approved application, so this is the way a
 * name, an address or a phone number is put right afterwards. Placement and
 * money are deliberately not here: the batch, the fee plan, the scholarship and
 * the documents stay as they were decided.
 */
export default async function EditStudentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(PERMISSIONS.ENROLLMENT_CREATE);
  const { id } = await params;

  const student = await prisma.student.findUnique({
    where: { id },
    include: { application: true },
  });
  if (!student) notFound();

  const { application } = student;

  return (
    <>
      <PageHeader
        title={`Edit ${student.fullName}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{student.studentCode}</span>
            <span>Admission details — corrections apply to the student record and the admission form alike.</span>
          </span>
        }
        actions={
          <LinkButton href={`/students/${id}`} variant="secondary">
            Back to record
          </LinkButton>
        }
      />

      <div className="space-y-6">
        <Alert tone="info" title="What this changes">
          Personal, contact and previous-education details only. The batch, semester, fee plan, scholarship and uploaded
          documents are settled at enrollment and are not editable here. Parent and guardian details are on the{" "}
          <Link href={`/enrollment/${student.applicationId}/guardians`} className="underline">
            application&apos;s guardians tab
          </Link>
          . Every change is written to the audit trail.
        </Alert>

        <StudentInfoForm
          action={updateStudentProfileAction}
          idFieldName="studentId"
          submitLabel="Save profile"
          values={{
            id: student.id,
            fullName: student.fullName,
            gender: student.gender,
            dob: student.dob ? student.dob.toISOString() : null,
            bloodGroup: student.bloodGroup,
            addressLine1: student.addressLine1,
            addressLine2: student.addressLine2,
            city: student.city,
            state: student.state,
            pincode: student.pincode,
            phone: student.phone,
            email: student.email,
            nationalId: student.nationalId,
            // Previous education is kept on the application only — the student
            // record has no columns for it — so those come from there.
            previousEnrollmentNo: application.previousEnrollmentNo,
            previousInstitution: application.previousInstitution,
            previousQualification: application.previousQualification,
            previousMarks: application.previousMarks,
            hasTransferCertificate: application.hasTransferCertificate,
          }}
        />
      </div>
    </>
  );
}
