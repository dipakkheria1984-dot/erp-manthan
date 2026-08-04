import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getInstitute, getInstituteLogo } from "@/lib/config";

/**
 * Serves the uploaded institute logo to the browser.
 *
 * The file lives under UPLOAD_DIR rather than /public — the same reason student
 * documents do — so it is read and streamed here instead of being served
 * statically. Callers append `?v=<logoUpdatedAt>` so a replaced logo is fetched
 * again rather than coming back from cache.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const institute = await getInstitute().catch(() => null);
  if (!institute?.logoStoragePath) {
    return NextResponse.json({ error: "No logo uploaded." }, { status: 404 });
  }

  const bytes = await getInstituteLogo(institute);
  if (!bytes) return NextResponse.json({ error: "The stored file is missing." }, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": institute.logoMimeType ?? "application/octet-stream",
      "content-disposition": `inline; filename="${encodeURIComponent(institute.logoFileName ?? "logo")}"`,
      // Safe to hold briefly: every URL that matters carries the version param.
      "cache-control": "private, max-age=300",
    },
  });
}
