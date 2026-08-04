import "server-only";
import path from "node:path";
import ExcelJS from "exceljs";
import { readStoredFile } from "@/lib/storage";
import { ValidationError } from "@/lib/errors";
import { startOfDay } from "@/lib/dates";

/**
 * Shared spreadsheet plumbing for every bulk import — students, academic
 * structure and receipts.
 *
 * Each importer supplies its own column definitions and validation; everything
 * here is about turning a stored .csv/.xlsx into trimmed cells and mapping a
 * header row onto keys, so one fix to date parsing or header matching applies
 * everywhere.
 */

export type ImportColumn = {
  key: string;
  header: string;
  /**
   * Other headers that mean the same column, so a file exported by another
   * system imports without being re-typed. Matched case- and punctuation-
   * insensitively, like `header` itself.
   */
  aliases?: string[];
  required?: boolean;
  help: string;
};

export type ImportIssue = { field?: string; message: string };

export type RawRow = {
  /** 1-indexed spreadsheet row, so messages match what the Admin sees. */
  rowNumber: number;
  values: Record<string, string>;
  /** Untouched cells, for columns matched by position rather than by key. */
  cells: string[];
};

/** RFC4180-style CSV split that respects quoted fields and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM, which Excel adds and which would corrupt the first header.
  const input = text.replace(/^﻿/, "");

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // Handled by the \n branch.
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === "object") {
    const rich = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (typeof rich.text === "string") return rich.text;
    if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text).join("");
    if (rich.result !== undefined) return cellToString(rich.result);
    return "";
  }
  return String(value);
}

function sheetToGrid(sheet: ExcelJS.Worksheet): string[][] {
  const grid: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    // `values` is 1-indexed with a leading hole.
    const values = row.values as unknown[];
    for (let i = 1; i < values.length; i += 1) {
      cells.push(cellToString(values[i]));
    }
    if (cells.some((cell) => cell.trim() !== "")) grid.push(cells);
  });
  return grid;
}

export function isCsv(storagePath: string): boolean {
  return path.extname(storagePath).toLowerCase() === ".csv";
}

/**
 * The stored spreadsheet's bytes. The two-pass import re-reads the same file to
 * commit what was previewed, so a file that has gone missing between the passes
 * has to surface as a domain error rather than a crash.
 */
async function readSpreadsheet(storagePath: string): Promise<ArrayBuffer> {
  const bytes = await readStoredFile(storagePath);
  if (!bytes) {
    throw new ValidationError("The uploaded file is no longer available. Upload it again.");
  }
  // ExcelJS declares its loader parameter as `interface Buffer extends
  // ArrayBuffer`, so an ArrayBuffer is what its types actually want — and what
  // the JSZip call underneath accepts. A Node Buffer may be a view onto a
  // larger pool, so copy rather than handing over `bytes.buffer` wholesale.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Decodes CSV bytes. `TextDecoder` drops a leading byte-order mark, which Excel
 * writes on every CSV it exports — left in place it becomes part of the first
 * header cell and that column silently fails to map.
 */
function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** The first sheet of a workbook, or the whole file when it is a CSV. */
export async function readGrid(storagePath: string): Promise<string[][]> {
  const bytes = await readSpreadsheet(storagePath);
  if (isCsv(storagePath)) return parseCsv(decodeUtf8(bytes));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.worksheets[0];
  return sheet ? sheetToGrid(sheet) : [];
}

/**
 * Every sheet of a workbook, keyed by name. Used by the academic import, where
 * departments, courses and batches each get their own sheet so one file can set
 * up the whole structure in dependency order.
 */
export async function readSheets(storagePath: string): Promise<Map<string, string[][]>> {
  const bytes = await readSpreadsheet(storagePath);
  const sheets = new Map<string, string[][]>();

  if (isCsv(storagePath)) {
    sheets.set("", parseCsv(decodeUtf8(bytes)));
    return sheets;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  for (const sheet of workbook.worksheets) {
    sheets.set(normaliseHeader(sheet.name), sheetToGrid(sheet));
  }
  return sheets;
}

export function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Maps a header row onto column keys. Unknown headers are ignored. */
export function mapHeaders(headerCells: string[], columns: ImportColumn[]): Map<string, number> {
  const lookup = new Map<string, string>(
    columns.flatMap((column): [string, string][] => [
      [normaliseHeader(column.header), column.key],
      [normaliseHeader(column.key), column.key],
      ...(column.aliases ?? []).map((alias): [string, string] => [normaliseHeader(alias), column.key]),
    ]),
  );

  const index = new Map<string, number>();
  headerCells.forEach((cell, position) => {
    const key = lookup.get(normaliseHeader(cell));
    // First occurrence wins, so a duplicated header cannot shadow the original.
    if (key && !index.has(key)) index.set(key, position);
  });
  return index;
}

/**
 * Turns a grid into keyed rows. Returns the fatal problems that stop a sheet
 * being read at all — a missing required column, or no recognisable headers.
 */
export function readRows(
  grid: string[][],
  columns: ImportColumn[],
  label: string,
): { rows: RawRow[]; fatal: string[] } {
  if (grid.length === 0) return { rows: [], fatal: [] };

  const columnIndex = mapHeaders(grid[0], columns);
  const fatal: string[] = [];

  if (columnIndex.size === 0) {
    fatal.push(`${label}: none of the column headers were recognised. Download the template and use its header row.`);
    return { rows: [], fatal };
  }

  const missing = columns.filter((column) => column.required && !columnIndex.has(column.key));
  if (missing.length > 0) {
    fatal.push(`${label}: missing required column(s) — ${missing.map((c) => c.header).join(", ")}.`);
    return { rows: [], fatal };
  }

  const rows = grid.slice(1).map((cells, index) => {
    const values: Record<string, string> = {};
    for (const [key, position] of columnIndex) values[key] = (cells[position] ?? "").trim();
    // +2 because the header is row 1 and spreadsheets are 1-indexed.
    return { rowNumber: index + 2, values, cells };
  });

  return { rows, fatal };
}

/* -------------------------------------------------------------------------- */
/* Field helpers                                                               */
/* -------------------------------------------------------------------------- */

export function text(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

export function parseDate(value: string | undefined): Date | "invalid" | null {
  const raw = text(value);
  if (!raw) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(date.getTime()) ? "invalid" : date;
  }

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  if (dmy) {
    const date = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return Number.isNaN(date.getTime()) ? "invalid" : date;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? "invalid" : startOfDay(fallback);
}

/** A rupee figure from a spreadsheet cell, tolerating thousands separators. */
export function parseRupees(value: string | undefined): number | "invalid" | null {
  const raw = text(value);
  if (!raw) return null;
  const numeric = Number(raw.replace(/[,\s₹]/g, ""));
  return Number.isFinite(numeric) ? numeric : "invalid";
}

export function parseWholeNumber(value: string | undefined): number | "invalid" | null {
  const raw = text(value);
  if (!raw) return null;
  const numeric = Number(raw.replace(/[,\s]/g, ""));
  return Number.isInteger(numeric) ? numeric : "invalid";
}
