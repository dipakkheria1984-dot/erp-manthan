import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { PERMISSIONS, hasAnyPermission } from "@/lib/permissions";
import { buildWelcomeKitPdf, loadWelcomeKit, welcomeKitFileName } from "@/lib/welcome-kit";

/**
 * The welcome kit handed to a family once their admission is approved
 * (spec 1.4 step 9) — one multi-page PDF holding the confirmation letter, the
 * admission form, the year-wise fee plan, the terms & conditions and the
 * registration fee receipt.
 *
 * Served inline so it can be read and printed straight from the browser;
 * `?download=1` forces a save-as instead.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!hasAnyPermission(user.permissions, [PERMISSIONS.ENROLLMENT_VIEW, PERMISSIONS.STUDENT_VIEW])) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const { id } = await params;
  const kit = await loadWelcomeKit(id);
  if (!kit.ok) {
    return kit.reason === "not-found"
      ? NextResponse.json({ error: "Application not found." }, { status: 404 })
      : NextResponse.json(
          { error: "The welcome kit is issued once the admission is approved and the student record exists." },
          { status: 409 },
        );
  }

  const buffer = await buildWelcomeKitPdf(kit);
  const disposition = request.nextUrl.searchParams.get("download") ? "attachment" : "inline";

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${disposition}; filename="${welcomeKitFileName(kit.student.studentCode)}"`,
      "cache-control": "private, no-store",
    },
  });
}
