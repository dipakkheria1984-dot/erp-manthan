import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSessionUser } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { IMPORT_COLUMNS, TEMPLATE_INSTALLMENT_PAIRS, installmentHeaders } from "@/lib/student-import";

/**
 * Downloadable import template. The header row is what `prepareImport` matches
 * against, and a second sheet documents every column so the file is
 * self-explanatory once it leaves the app.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!hasPermission(user.permissions, PERMISSIONS.STUDENT_IMPORT)) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const format = (new URL(request.url).searchParams.get("format") ?? "xlsx").toLowerCase();

  // IMPORT_COLUMNS ends with the first installment pair, so the extra pairs
  // append directly after it and stay adjacent in the sheet.
  const extraPairs = Array.from({ length: TEMPLATE_INSTALLMENT_PAIRS - 1 }, (_, i) => installmentHeaders(i + 2));
  const headers = [
    ...IMPORT_COLUMNS.map((column) => column.header),
    ...extraPairs.flatMap((pair) => [pair.amount, pair.due]),
  ];
  const isRequired = (index: number) => Boolean(IMPORT_COLUMNS[index]?.required);

  const sample = [
    "Riya Sharma",
    "Female",
    "CE",
    "BTCE",
    "BTCE26",
    "", // LF No — blank means auto-assign
    "1",
    "Active",
    "2026-06-01",
    "2008-04-12",
    "O+",
    "+919876543210",
    "riya.sharma@example.com",
    "12 Rose Villa",
    "",
    "Ahmedabad",
    "Gujarat",
    "380001",
    "1234-5678-9012",
    "OLD-2024-117",
    "Mahesh Sharma",
    "Father",
    "+919812345678",
    "mahesh.sharma@example.com",
    "Engineer",
    // An opening balance of three installments on different dates; the fourth
    // pair is left blank to show that unused pairs are simply skipped.
    "24125",
    "2026-08-15",
    "24125",
    "2026-09-15",
    "24125",
    "2026-10-15",
    "",
    "",
  ];

  if (format === "csv") {
    const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
    // A BOM makes Excel open the UTF-8 file with the right encoding.
    const csv = `﻿${[headers.map(csvCell).join(","), sample.map(csvCell).join(",")].join("\r\n")}`;
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="student-import-template.csv"',
      },
    });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Institute ERP";

  const sheet = workbook.addWorksheet("Students");
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell, index) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: isRequired(index - 1) ? "FFFDE7E7" : "FFEFF2F6" },
    };
  });
  sheet.addRow(sample);
  // Text format everywhere so IDs and phone numbers keep leading zeros.
  headers.forEach((header, index) => {
    const column = sheet.getColumn(index + 1);
    column.width = Math.min(30, Math.max(14, header.length + 4));
    column.numFmt = "@";
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const guide = workbook.addWorksheet("Column guide");
  guide.addRow(["Column", "Required", "Notes"]).font = { bold: true };
  for (const column of IMPORT_COLUMNS) {
    guide.addRow([column.header, column.required ? "Yes" : "Optional", column.help]);
  }
  for (const pair of extraPairs) {
    guide.addRow([
      `${pair.amount} / ${pair.due}`,
      "Optional",
      "A further installment of the opening balance. Leave both blank if unused. Add more numbered pairs by hand if a student owes more installments than this template provides.",
    ]);
  }
  guide.getColumn(1).width = 26;
  guide.getColumn(2).width = 12;
  guide.getColumn(3).width = 82;
  guide.getColumn(3).alignment = { wrapText: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(Buffer.from(buffer)), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="student-import-template.xlsx"',
    },
  });
}
