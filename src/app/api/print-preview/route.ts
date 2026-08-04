import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getInstitute, getInstituteLogo } from "@/lib/config";
import { PERMISSIONS, hasAnyPermission } from "@/lib/permissions";
import {
  createDocument,
  drawFieldRows,
  drawFooter,
  drawHeader,
  drawParagraph,
  drawSignatureRow,
  drawTable,
  sectionHeading,
  toBuffer,
} from "@/lib/pdf";
import { resolvePrintStyle } from "@/lib/print-theme";

/**
 * A sample document in a given colour scheme and theme, for the picker in
 * Institute setup (spec 9.1).
 *
 * The scheme, theme and accent are read from the query string rather than from
 * the saved institute row, so the admin can see a real PDF — same fonts, same
 * renderer — before committing the choice. Nothing is written; only the
 * appearance is overridden, every other detail comes from the live profile.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!hasAnyPermission(user.permissions, [PERMISSIONS.INSTITUTE_MANAGE])) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const institute = await getInstitute();
  const params = new URL(request.url).searchParams;
  // Unknown ids fall back to the defaults inside `resolvePrintStyle`, so a
  // hand-edited URL can only ever produce a document, never an error.
  const style = resolvePrintStyle({
    printColorScheme: params.get("scheme") ?? institute.printColorScheme,
    printTheme: params.get("theme") ?? institute.printTheme,
    printAccentHex: params.get("accent") ?? institute.printAccentHex,
  });

  const doc = createDocument({
    title: "Print appearance sample",
    style,
    logo: await getInstituteLogo(institute),
  });

  drawHeader(doc, institute, "SAMPLE DOCUMENT", `${style.scheme.label} · ${style.theme.label}`);

  drawParagraph(
    doc,
    `This sample shows how fee receipts, admission forms, the welcome kit and report exports will look in the ` +
      `${style.scheme.label} colour scheme with the ${style.theme.label} theme. It is not a real record and nothing ` +
      "has been saved.",
  );

  sectionHeading(doc, "Field rows");
  doc.moveDown(0.3);
  drawFieldRows(doc, [
    ["Student name", "Aarav Sharma"],
    ["Student ID", "STU10042"],
    ["Course", "B.Tech Computer Engineering"],
    ["Batch", "CE-2026 (CE26)"],
    ["Receipt no.", "RCP00042"],
    ["Payment mode", "UPI"],
  ]);

  sectionHeading(doc, "Tables");
  doc.moveDown(0.3);
  drawTable(
    doc,
    [
      { header: "Particulars", width: 240 },
      { header: "Due date", width: 130 },
      { header: "Amount", width: 145, align: "right" },
    ],
    [
      ["Installment 1 — semester 1", "10 Jul 2026", "₹25,000.00"],
      ["Installment 2 — semester 1", "10 Oct 2026", "₹25,000.00"],
      ["Late fee", "—", "₹250.00"],
      ["Total received", "", "₹50,250.00"],
    ],
  );
  doc.moveDown(0.6);

  sectionHeading(doc, "Headings and body text");
  doc.moveDown(0.3);
  drawParagraph(
    doc,
    "Body text stays near-black on every scheme so long passages — terms & conditions, the welcome letter — remain " +
      "comfortable to read. Only headings, rules and table headers take the accent colour. The Monochrome scheme " +
      "reproduces identically on a black-and-white printer or photocopier.",
    { size: 8.5 },
  );
  drawParagraph(doc, "देवनागरी में लिखे नाम भी इसी तरह छपते हैं।", { size: 8.5 });

  drawSignatureRow(doc, "Student / guardian signature", `For ${institute.name}`);
  drawFooter(doc, "Sample document · generated for the print appearance picker · not a record.");

  const buffer = await toBuffer(doc);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": 'inline; filename="print-appearance-sample.pdf"',
      "cache-control": "private, no-store",
    },
  });
}
