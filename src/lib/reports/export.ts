import "server-only";
import ExcelJS from "exceljs";
import type { Institute } from "@/generated/prisma/client";
import { getInstituteLogo } from "@/lib/config";
import { formatDateTime } from "@/lib/dates";
import {
  createDocument,
  drawFooter,
  drawHeader,
  drawParagraph,
  drawTable,
  ensureSpace,
  paletteOf,
  sectionHeading,
  toBuffer,
  applyFontFor,
} from "@/lib/pdf";
import { resolvePrintStyle } from "@/lib/print-theme";
import type { ReportResult } from "./types";

/**
 * Every export carries the same header block: report name, the filters that
 * were applied, and the generation timestamp (spec 7).
 */
function headerLines(report: ReportResult): string[] {
  return [
    ...report.filterSummary.map((line) => `Filter — ${line}`),
    // Unprefixed: the columns on show are not one of the filters.
    ...(report.columnNote ? [report.columnNote] : []),
    `Generated: ${formatDateTime(new Date())}`,
    `Rows: ${report.rows.length}`,
  ];
}

export async function reportToPdf(report: ReportResult, institute: Institute): Promise<Buffer> {
  const doc = createDocument({
    title: report.title,
    landscape: report.landscape,
    style: resolvePrintStyle(institute),
    logo: await getInstituteLogo(institute),
  });
  drawHeader(doc, institute, report.title.toUpperCase());

  const palette = paletteOf(doc);
  doc.fontSize(7.5).fillColor(palette.muted);
  for (const line of headerLines(report)) {
    applyFontFor(doc, line).text(line);
  }
  doc.fillColor(palette.ink).moveDown(0.6);

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const declared = report.columns.reduce((sum, column) => sum + (column.width ?? 80), 0);
  // Scale the declared widths to fill the page without overflowing it.
  const scale = usable / declared;

  const columns = report.columns.map((column) => ({
    header: column.header,
    width: (column.width ?? 80) * scale,
    align: column.align,
  }));

  // Money columns carry bare numbers so Excel and CSV stay machine-readable;
  // the PDF is for humans, so it gets the ₹ sign (the embedded font has it).
  const cell = (row: ReportResult["rows"][number], column: ReportResult["columns"][number]) => {
    const value = row[column.key];
    if (column.money && typeof value === "string" && value !== "" && Number.isFinite(Number(value))) {
      return `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return String(value ?? "");
  };

  const rows = report.rows.map((row) => report.columns.map((column) => cell(row, column)));
  if (report.totals) {
    rows.push(report.columns.map((column) => cell(report.totals!, column)));
  }

  drawTable(doc, columns, rows);

  for (const section of report.sections ?? []) {
    doc.moveDown(1);
    ensureSpace(doc, 90);
    sectionHeading(doc, section.title.toUpperCase());
    doc.moveDown(0.3);
    if (section.description) drawParagraph(doc, section.description, { size: 7.5 });

    if (section.rows.length === 0) {
      drawParagraph(doc, section.emptyMessage ?? "Nothing to show.", { size: 8 });
      continue;
    }

    // Scaled the same way as the main table, so a section fills the page width
    // rather than huddling at the left margin.
    const sectionDeclared = section.columns.reduce((sum, column) => sum + (column.width ?? 80), 0);
    const sectionScale = usable / sectionDeclared;
    drawTable(
      doc,
      section.columns.map((column) => ({
        header: column.header,
        width: (column.width ?? 80) * sectionScale,
        align: column.align,
      })),
      [
        ...section.rows.map((row) => section.columns.map((column) => cell(row, column))),
        ...(section.totals ? [section.columns.map((column) => cell(section.totals!, column))] : []),
      ],
    );
  }

  drawFooter(doc);

  return toBuffer(doc);
}

/** ExcelJS wants opaque ARGB (`FFrrggbb`), the palette stores CSS hex. */
function argb(hex: string): string {
  return `FF${hex.replace("#", "").toUpperCase()}`;
}

export async function reportToExcel(report: ReportResult, institute: Institute): Promise<Buffer> {
  const { palette } = resolvePrintStyle(institute);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = institute.name;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(report.title.slice(0, 30).replace(/[*?:\\/[\]]/g, "-"));
  const columnCount = report.columns.length;

  const addBanner = (text: string, bold = false, size = 10, color?: string) => {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, Math.max(1, columnCount));
    row.getCell(1).font = { bold, size, color: color ? { argb: color } : undefined };
    return row;
  };

  addBanner(institute.name, true, 13, argb(palette.accent));
  addBanner(report.title, true, 11, argb(palette.accent));
  for (const line of headerLines(report)) addBanner(line, false, 9, argb(palette.muted));
  sheet.addRow([]);

  const headerRow = sheet.addRow(report.columns.map((column) => column.header));
  headerRow.font = { bold: true, color: { argb: argb(palette.accent) } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(palette.tint) } };
    cell.border = { bottom: { style: "thin", color: { argb: argb(palette.rule) } } };
  });

  for (const row of report.rows) {
    const values = report.columns.map((column) => {
      const value = row[column.key];
      // Money and count columns go in as numbers so Excel can total them.
      if (column.money && typeof value === "string" && value !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
      }
      return value ?? "";
    });
    sheet.addRow(values);
  }

  if (report.totals) {
    const totalsRow = sheet.addRow(
      report.columns.map((column) => {
        const value = report.totals?.[column.key];
        if (column.money && typeof value === "string" && value !== "") {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : value;
        }
        return value ?? "";
      }),
    );
    totalsRow.font = { bold: true };
    totalsRow.eachCell((cell) => {
      cell.border = { top: { style: "thin", color: { argb: argb(palette.accent) } } };
    });
  }

  report.columns.forEach((column, index) => {
    const sheetColumn = sheet.getColumn(index + 1);
    sheetColumn.width = Math.min(48, Math.max(12, Math.round((column.width ?? 80) / 5)));
    if (column.money) sheetColumn.numFmt = "#,##0.00";
    if (column.align === "right") sheetColumn.alignment = { horizontal: "right" };
  });

  // Extra tables get a sheet each rather than being stacked underneath: column
  // widths and number formats are per-sheet in Excel, and a second table with
  // different columns would otherwise inherit the first one's.
  for (const section of report.sections ?? []) {
    const sectionSheet = workbook.addWorksheet(section.title.slice(0, 30).replace(/[*?:\\/[\]]/g, "-"));
    const banner = sectionSheet.addRow([section.title]);
    sectionSheet.mergeCells(banner.number, 1, banner.number, Math.max(1, section.columns.length));
    banner.getCell(1).font = { bold: true, size: 11, color: { argb: argb(palette.accent) } };
    if (section.description) {
      const note = sectionSheet.addRow([section.description]);
      sectionSheet.mergeCells(note.number, 1, note.number, Math.max(1, section.columns.length));
      note.getCell(1).font = { size: 9, color: { argb: argb(palette.muted) } };
    }
    sectionSheet.addRow([]);

    if (section.rows.length === 0) {
      sectionSheet.addRow([section.emptyMessage ?? "Nothing to show."]);
      continue;
    }

    const sectionHeader = sectionSheet.addRow(section.columns.map((column) => column.header));
    sectionHeader.font = { bold: true, color: { argb: argb(palette.accent) } };
    sectionHeader.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(palette.tint) } };
      cell.border = { bottom: { style: "thin", color: { argb: argb(palette.rule) } } };
    });

    for (const row of section.rows) {
      sectionSheet.addRow(
        section.columns.map((column) => {
          const value = row[column.key];
          if (column.money && typeof value === "string" && value !== "") {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : value;
          }
          return value ?? "";
        }),
      );
    }
    if (section.totals) {
      const totalsRow = sectionSheet.addRow(
        section.columns.map((column) => {
          const value = section.totals?.[column.key];
          if (column.money && typeof value === "string" && value !== "") {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : value;
          }
          return value ?? "";
        }),
      );
      totalsRow.font = { bold: true };
      totalsRow.eachCell((cell) => {
        cell.border = { top: { style: "thin", color: { argb: argb(palette.accent) } } };
      });
    }

    section.columns.forEach((column, index) => {
      const sheetColumn = sectionSheet.getColumn(index + 1);
      sheetColumn.width = Math.min(48, Math.max(12, Math.round((column.width ?? 80) / 5)));
      if (column.money) sheetColumn.numFmt = "#,##0.00";
      if (column.align === "right") sheetColumn.alignment = { horizontal: "right" };
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function reportToCsv(report: ReportResult, institute: Institute): string {
  const lines: string[] = [
    csvCell(institute.name),
    csvCell(report.title),
    ...headerLines(report).map(csvCell),
    "",
    report.columns.map((column) => csvCell(column.header)).join(","),
  ];

  for (const row of report.rows) {
    lines.push(report.columns.map((column) => csvCell(row[column.key])).join(","));
  }
  if (report.totals) {
    lines.push(report.columns.map((column) => csvCell(report.totals?.[column.key])).join(","));
  }

  // Extra tables follow, each after a blank line and its own title, so a
  // spreadsheet opened from the CSV keeps them visibly apart.
  for (const section of report.sections ?? []) {
    lines.push("", csvCell(section.title));
    if (section.description) lines.push(csvCell(section.description));
    if (section.rows.length === 0) {
      lines.push(csvCell(section.emptyMessage ?? "Nothing to show."));
      continue;
    }
    lines.push(section.columns.map((column) => csvCell(column.header)).join(","));
    for (const row of section.rows) {
      lines.push(section.columns.map((column) => csvCell(row[column.key])).join(","));
    }
    if (section.totals) {
      lines.push(section.columns.map((column) => csvCell(section.totals?.[column.key])).join(","));
    }
  }

  return lines.join("\r\n");
}
