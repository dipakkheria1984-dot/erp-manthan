import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { readStoredFile } from "@/lib/storage";

/**
 * Serves the institute's payment QR.
 *
 * Public, unlike the logo route next door, because the applicant looking at it
 * is a member of the public who has not signed in — and because a payment QR is
 * meant to be seen. It carries no personal data: it encodes the institute's own
 * collection address, the same thing that would be printed on a poster in the
 * office.
 *
 * The file lives under UPLOAD_DIR rather than /public for the same reason every
 * other upload does, so it is read and streamed here. Callers append
 * `?v=<paymentQrUpdatedAt>` so a replaced code is fetched again instead of
 * coming back from cache.
 */
export async function GET() {
  const config = await getConfig().catch(() => null);
  if (!config?.paymentQrStoragePath) {
    return NextResponse.json({ error: "No payment QR uploaded." }, { status: 404 });
  }

  const bytes = await readStoredFile(config.paymentQrStoragePath);
  if (!bytes) return NextResponse.json({ error: "The stored file is missing." }, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": config.paymentQrMimeType ?? "application/octet-stream",
      "content-disposition": `inline; filename="${encodeURIComponent(config.paymentQrFileName ?? "payment-qr")}"`,
      // Public rather than private: there is nothing here specific to a viewer,
      // and the version parameter is what makes a replacement take effect.
      "cache-control": "public, max-age=300",
    },
  });
}
