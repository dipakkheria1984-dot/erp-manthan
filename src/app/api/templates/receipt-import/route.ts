import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSessionUser } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { RECEIPT_COLUMNS } from "@/lib/imports/receipts";

/**
 * Downloadable receipt-import template. The header row is what
 * `prepareReceiptImport` matches against, and a second sheet documents every
 * column so the file is self-explanatory once it leaves the app.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!hasPermission(user.permissions, PERMISSIONS.FEE_COLLECT)) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const format = (new URL(request.url).searchParams.get("format") ?? "xlsx").toLowerCase();
  const headers = RECEIPT_COLUMNS.map((column) => column.header);

  // Column order follows RECEIPT_COLUMNS: ID, Name, Receipt No., Payment Mode,
  // Amount Paid (Rs), Paid Date, Reference No, Remarks.
  const samples = [
    ["IIFD-KOL-10001", "ARYA PANDEY", "FY 26-27/417", "UPI", "24125", "15/08/2026", "UPI-8842137755", "Installment 1"],
    ["IIFD-KOL-10001", "ARYA PANDEY", "FY 26-27/532", "Cash", "24125", "15/09/2026", "", ""],
    ["IIFD-KOL-00009", "AMRITA DEY", "", "Cheque/PDC/DD No.", "50000", "20/08/2026", "CHQ-114520", "Cleared 22 Aug"],
  ];

  if (format === "csv") {
    const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
    // A BOM makes Excel open the UTF-8 file with the right encoding.
    const csv = `﻿${[headers, ...samples].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="receipt-import-template.csv"',
      },
    });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Institute ERP";

  const sheet = workbook.addWorksheet("Receipts");
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell, index) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: RECEIPT_COLUMNS[index - 1]?.required ? "FFFDE7E7" : "FFEFF2F6" },
    };
  });
  for (const sample of samples) sheet.addRow(sample);
  headers.forEach((header, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = Math.min(30, Math.max(14, header.length + 4));
    // Text format everywhere so receipt numbers keep leading zeros.
    column.numFmt = "@";
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const guide = workbook.addWorksheet("Column guide");
  guide.addRow(["Column", "Required", "Also accepted as", "Notes"]).font = { bold: true };
  for (const column of RECEIPT_COLUMNS) {
    guide.addRow([
      column.header,
      column.required ? "Yes" : "Optional",
      (column.aliases ?? []).join(", "),
      column.help,
    ]);
  }
  guide.addRow([]);
  guide.addRow([
    "How the money is applied",
    "",
    "",
    "Each row settles installments oldest due date first, clearing any late fee on an installment before its principal — the same as one collection on the Collect Fees screen. Rows are applied in payment-date order.",
  ]);
  guide.addRow([
    "Several rows per student",
    "",
    "",
    "Allowed. The preview applies them cumulatively, so it will tell you if they add up to more than the student owes.",
  ]);
  guide.getColumn(1).width = 26;
  guide.getColumn(2).width = 12;
  guide.getColumn(3).width = 34;
  guide.getColumn(4).width = 88;
  guide.getColumn(4).alignment = { wrapText: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(Buffer.from(buffer)), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="receipt-import-template.xlsx"',
    },
  });
}
