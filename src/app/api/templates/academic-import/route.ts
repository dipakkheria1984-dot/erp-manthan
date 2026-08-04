import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSessionUser } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { BATCH_COLUMNS, COURSE_COLUMNS, DEPARTMENT_COLUMNS, SHEETS } from "@/lib/imports/academic";
import type { ImportColumn } from "@/lib/imports/grid";

/**
 * Downloadable academic-structure template: one workbook whose three sheets are
 * what `prepareAcademicImport` reads, plus a guide sheet documenting every
 * column so the file is self-explanatory once it leaves the app.
 *
 * Excel only — the three sheets have to travel together for the dependency
 * ordering to work.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!hasPermission(user.permissions, PERMISSIONS.ACADEMIC_MANAGE)) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Institute ERP";

  const addSheet = (name: string, columns: ImportColumn[], samples: string[][]) => {
    const sheet = workbook.addWorksheet(name);
    const headerRow = sheet.addRow(columns.map((column) => column.header));
    headerRow.font = { bold: true };
    headerRow.eachCell((cell, index) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: columns[index - 1]?.required ? "FFFDE7E7" : "FFEFF2F6" },
      };
    });
    for (const sample of samples) sheet.addRow(sample);
    columns.forEach((column, index) => {
      const sheetColumn = sheet.getColumn(index + 1);
      sheetColumn.width = Math.min(30, Math.max(14, column.header.length + 4));
      // Text format everywhere so codes keep any leading zeros.
      sheetColumn.numFmt = "@";
    });
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  };

  addSheet(SHEETS.departments.name, DEPARTMENT_COLUMNS, [
    ["CE", "Computer Engineering", "Dr. A. Mehta", "Active"],
    ["ME", "Mechanical Engineering", "", "Active"],
  ]);

  addSheet(SHEETS.courses.name, COURSE_COLUMNS, [
    ["BTCE", "B.Tech Computer Engineering", "CE", "4", "8", "Active"],
    ["BTME", "B.Tech Mechanical Engineering", "ME", "4", "8", "Active"],
  ]);

  addSheet(SHEETS.batches.name, BATCH_COLUMNS, [
    ["BTCE26", "BTCE 2026 Intake", "BTCE", "2026-06-01", "2030-05-31", "60", "120000", "Upcoming"],
    ["BTME26", "BTME 2026 Intake", "BTME", "2026-06-01", "2030-05-31", "60", "110000", "Upcoming"],
  ]);

  const guide = workbook.addWorksheet("Column guide");
  guide.addRow(["Sheet", "Column", "Required", "Notes"]).font = { bold: true };
  const sections: [string, ImportColumn[]][] = [
    [SHEETS.departments.name, DEPARTMENT_COLUMNS],
    [SHEETS.courses.name, COURSE_COLUMNS],
    [SHEETS.batches.name, BATCH_COLUMNS],
  ];
  for (const [sheetName, columns] of sections) {
    for (const column of columns) {
      guide.addRow([sheetName, column.header, column.required ? "Yes" : "Optional", column.help]);
    }
  }
  guide.addRow([]);
  guide.addRow([
    "",
    "Order matters",
    "",
    "Sheets are applied Departments → Courses → Batches, so a course may name a department defined in this same file, and a batch may name a course defined in this same file.",
  ]);
  guide.addRow([
    "",
    "Creates only",
    "",
    "A code that already exists is reported as an error rather than overwritten. Remove those rows before importing.",
  ]);
  guide.getColumn(1).width = 16;
  guide.getColumn(2).width = 24;
  guide.getColumn(3).width = 12;
  guide.getColumn(4).width = 88;
  guide.getColumn(4).alignment = { wrapText: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(Buffer.from(buffer)), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="academic-structure-template.xlsx"',
    },
  });
}
