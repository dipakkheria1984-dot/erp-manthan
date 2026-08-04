import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { PERMISSIONS, hasAnyPermission } from "@/lib/permissions";
import { readStoredFile } from "@/lib/storage";

/**
 * Serves an uploaded student document. Files live outside /public precisely so
 * that this authorisation check cannot be bypassed by guessing a URL.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  if (
    !hasAnyPermission(user.permissions, [
      PERMISSIONS.ENROLLMENT_VIEW,
      PERMISSIONS.ENROLLMENT_VERIFY_DOCUMENTS,
      PERMISSIONS.STUDENT_VIEW,
    ])
  ) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const { id } = await params;
  const document = await prisma.applicationDocument.findUnique({ where: { id } });
  if (!document) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const bytes = await readStoredFile(document.storagePath);
  if (!bytes) {
    return NextResponse.json({ error: "The stored file is missing." }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": document.mimeType,
      "content-disposition": `inline; filename="${encodeURIComponent(document.fileName)}"`,
      "cache-control": "private, no-store",
    },
  });
}
