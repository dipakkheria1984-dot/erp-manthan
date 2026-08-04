import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { PERMISSIONS, hasAnyPermission } from "@/lib/permissions";
import { buildReceiptPdf, resolveReceiptNo } from "@/lib/receipt-pdf";

/**
 * Fee receipt PDF (spec 10.2). The document itself is built by
 * src/lib/receipt-pdf.ts, which the "Email receipt" action uses too, so the
 * emailed copy and the printed one are the same file.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!hasAnyPermission(user.permissions, [PERMISSIONS.FEE_COLLECT, PERMISSIONS.REPORT_FEE_COLLECTION, PERMISSIONS.REPORT_LEDGER])) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const { id } = await params;
  const receiptNo = await resolveReceiptNo(id);
  if (!receiptNo) return NextResponse.json({ error: "Receipt not found." }, { status: 404 });

  const receipt = await buildReceiptPdf(receiptNo);
  if (!receipt) return NextResponse.json({ error: "Receipt not found." }, { status: 404 });

  return new NextResponse(new Uint8Array(receipt.buffer), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${receipt.fileName}"`,
      "cache-control": "private, no-store",
    },
  });
}
