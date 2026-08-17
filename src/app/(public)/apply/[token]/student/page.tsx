import { notFound } from "next/navigation";
import { applicationForToken } from "@/lib/applicant-portal";
import { StudentInfoForm } from "@/app/(app)/enrollment/student-info-form";
import { savePortalStudentInfoAction } from "../../actions";

/**
 * The applicant fills in the very same fields the office would type for them,
 * so this reuses the wizard's form outright — pointed at the public action and
 * carrying the token where the wizard carries the application id.
 */
export default async function PortalStudentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await applicationForToken(token);
  // The layout has already shown the applicant why an invalid token failed;
  // reaching here with one would mean a race, and there is nothing to render.
  if (!result.ok) notFound();

  const a = result.application;

  return (
    <StudentInfoForm
      action={savePortalStudentInfoAction}
      idFieldName="token"
      submitLabel="Save and continue"
      values={{
        id: token,
        fullName: a.fullName,
        gender: a.gender,
        dob: a.dob ? a.dob.toISOString() : null,
        bloodGroup: a.bloodGroup,
        addressLine1: a.addressLine1,
        addressLine2: a.addressLine2,
        city: a.city,
        state: a.state,
        pincode: a.pincode,
        phone: a.phone,
        email: a.email,
        nationalId: a.nationalId,
        previousEnrollmentNo: a.previousEnrollmentNo,
        previousInstitution: a.previousInstitution,
        previousQualification: a.previousQualification,
        previousMarks: a.previousMarks,
        hasTransferCertificate: a.hasTransferCertificate,
      }}
    />
  );
}
