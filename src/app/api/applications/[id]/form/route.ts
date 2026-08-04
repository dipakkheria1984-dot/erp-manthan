import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getInstitute, getInstituteLogo } from "@/lib/config";
import { PERMISSIONS, hasAnyPermission } from "@/lib/permissions";
import { termsInForce } from "@/lib/terms";
import { createDocument, drawFooter, drawHeader, drawTerms, toBuffer } from "@/lib/pdf";
import { resolvePrintStyle } from "@/lib/print-theme";
import { drawAdmissionFormBody, loadAdmissionForm } from "@/lib/pdf-sections";

/** Admission form printout with the terms & conditions printed on it (spec 10.2). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!hasAnyPermission(user.permissions, [PERMISSIONS.ENROLLMENT_VIEW, PERMISSIONS.STUDENT_VIEW])) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const { id } = await params;
  const application = await loadAdmissionForm(id);
  if (!application) return NextResponse.json({ error: "Application not found." }, { status: 404 });

  const [institute, terms] = await Promise.all([getInstitute(), termsInForce("ADMISSION")]);

  const doc = createDocument({
    title: `Admission form ${application.applicationNo ?? application.id}`,
    style: resolvePrintStyle(institute),
    logo: await getInstituteLogo(institute),
  });
  drawHeader(
    doc,
    institute,
    "ADMISSION FORM",
    application.applicationNo ? `Application ID: ${application.applicationNo}` : "Draft application",
  );

  drawAdmissionFormBody(doc, application);
  drawTerms(doc, terms);
  drawFooter(doc);

  const buffer = await toBuffer(doc);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="admission-form-${application.applicationNo ?? application.id}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
