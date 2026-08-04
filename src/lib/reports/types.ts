import { PERMISSIONS, type Permission } from "@/lib/permissions";

/**
 * Every report in the suite (spec 7) produces the same shape, so filters,
 * on-screen tables, PDF export and Excel/CSV export share one implementation.
 */

export type ReportColumn = {
  key: string;
  header: string;
  align?: "left" | "right";
  /** Relative width hint used by the PDF renderer. */
  width?: number;
  /** Formatted as a money column in Excel. */
  money?: boolean;
  /**
   * On-screen only: renders a non-empty cell as a link, with `{value}` replaced
   * by the cell's text. PDF, Excel and CSV exports keep the plain value, so a
   * printed report never carries a dead URL.
   */
  linkTemplate?: string;
};

export type ReportRow = Record<string, string | number | null>;

/**
 * A second table printed under the main one, with its own columns.
 *
 * The Student Ledger uses it for the schedule of installments still to fall
 * due: those are not transactions — nothing has moved — so they cannot sit in
 * the ledger itself, but the family still needs to see what is coming.
 */
export type ReportSection = {
  title: string;
  description?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: ReportRow;
  /** Shown when there are no rows, instead of an empty table. */
  emptyMessage?: string;
  /**
   * On-screen only: appends an action column to the section's table.
   *
   * `waive-late-fee` puts the late fee write-off on each row that still carries
   * one, so an Accountant answering a family's question from the ledger settles
   * it there rather than going back to the collection screen. Every row it
   * applies to must carry `installmentId` and `lateFeeOutstandingPaise`; those
   * keys have no column of their own, so PDF, Excel and CSV never see them and
   * a printed ledger carries no dead "Action" column.
   */
  rowAction?: "waive-late-fee";
};

export type ReportResult = {
  title: string;
  /** The columns to render. Narrowed to the viewer's choice by `selectColumns`. */
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Human-readable list of the filters that were applied, printed on exports. */
  filterSummary: string[];
  /** Optional totals row appended to the table. */
  totals?: ReportRow;
  /** Extra context shown above the table on screen. */
  notes?: string[];
  landscape?: boolean;
  /**
   * Extra tables printed beneath the main one. Untouched by the column picker,
   * which narrows the main table only.
   */
  sections?: ReportSection[];
  /**
   * Every column the report can produce, set only when the viewer has hidden
   * some. The column picker needs the full list to offer the hidden ones back.
   */
  allColumns?: ReportColumn[];
  /**
   * Says so when columns have been hidden, printed at the head of every export
   * so a shortened report is never mistaken for the full one. Kept out of
   * `filterSummary` because exports prefix those with "Filter — ", and the
   * columns on show are not a filter.
   */
  columnNote?: string;
};

export type ReportKey =
  | "student-records"
  | "department-wise"
  | "course-wise"
  | "ledger"
  | "fee-collection"
  | "fee-due";

export type ReportParams = Record<string, string>;

export const REPORT_DEFINITIONS: {
  key: ReportKey;
  title: string;
  description: string;
  permission: Permission;
  /** Which filter controls the page renders. */
  filters: (
    | "dateRange"
    | "department"
    | "course"
    | "batch"
    | "semester"
    | "status"
    | "gender"
    | "academicYear"
    | "student"
    | "mode"
    | "collectedBy"
    | "overdueBucket"
    | "lateFeeOnly"
    | "dueStatus"
    | "paymentStatus"
  )[];
}[] = [
  {
    key: "student-records",
    title: "Student Records",
    description: "Full student register with department, course, batch, semester and status.",
    permission: PERMISSIONS.REPORT_STUDENT_RECORDS,
    filters: ["department", "course", "batch", "semester", "status", "gender", "dateRange"],
  },
  {
    key: "department-wise",
    title: "Department-wise",
    description: "Student totals per department with a course-wise breakup and status counts.",
    permission: PERMISSIONS.REPORT_DEPARTMENT_WISE,
    filters: ["department", "academicYear", "status"],
  },
  {
    key: "course-wise",
    title: "Course-wise",
    description: "Student totals per course with batch-wise breakup, semester distribution and status counts.",
    permission: PERMISSIONS.REPORT_COURSE_WISE,
    filters: ["department", "course", "batch", "academicYear", "status"],
  },
  {
    key: "ledger",
    title: "Student Ledger",
    description:
      "Full transaction history for a student — fees assigned, installments, payments including partials, late fees, waivers and a running balance. Cancelled receipts are excluded; they are on record in the Receipts register and the audit trail.",
    permission: PERMISSIONS.REPORT_LEDGER,
    filters: ["student", "department", "course", "batch", "semester", "dateRange"],
  },
  {
    key: "fee-collection",
    title: "Fee Collection",
    description:
      "Money actually collected. Cancelled/voided receipts are excluded entirely from this report and its totals.",
    permission: PERMISSIONS.REPORT_FEE_COLLECTION,
    filters: ["dateRange", "department", "course", "batch", "mode", "collectedBy"],
  },
  {
    key: "fee-due",
    title: "Fee Due",
    description:
      "One row per student, combining all their outstanding installments: total fees, paid, current and future dues, " +
      "late fee and what is payable today. Includes parent contact numbers for follow-up.",
    permission: PERMISSIONS.REPORT_FEE_DUE,
    filters: ["dateRange", "department", "course", "batch", "dueStatus", "overdueBucket", "lateFeeOnly"],
  },
];

export function reportDefinition(key: string) {
  return REPORT_DEFINITIONS.find((report) => report.key === key) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Column selection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Query parameter holding the columns the viewer wants, as a comma-separated
 * list of column keys.
 *
 * It rides in the URL alongside the filters for one reason: the export links
 * already carry the whole query string to /api/reports/[key], so a PDF, Excel
 * or CSV automatically contains exactly the columns on screen without the two
 * paths having to agree about anything.
 */
export const COLUMNS_PARAM = "columns";

/** Column keys from a `columns=` value; null when nothing usable was given. */
export function parseColumnSelection(raw: string | undefined | null): string[] | null {
  if (!raw) return null;
  const keys = raw.split(",").map((key) => key.trim()).filter(Boolean);
  return keys.length > 0 ? keys : null;
}

/** Serialises a selection, or "" when every column is on — see `selectColumns`. */
export function serialiseColumnSelection(chosen: readonly string[], all: readonly ReportColumn[]): string {
  return chosen.length === all.length ? "" : chosen.join(",");
}

/**
 * Narrows a report to the columns the viewer asked for.
 *
 * Rows and totals are deliberately left whole — every renderer walks `columns`
 * and looks each key up, so trimming the data would buy nothing and would break
 * a totals row that still needs its own untouched keys.
 *
 * No selection means every column, which is what an absent parameter, an empty
 * one, or a stale link naming columns this report no longer has all fall back
 * to. Showing the full report beats rendering a table with no columns in it.
 */
export function selectColumns(report: ReportResult, raw: string | undefined | null): ReportResult {
  const chosen = parseColumnSelection(raw);
  if (!chosen) return report;

  const wanted = new Set(chosen);
  // Filtering the report's own list rather than mapping over `chosen` keeps the
  // report's canonical column order, whatever order the parameter arrived in.
  const columns = report.columns.filter((column) => wanted.has(column.key));
  if (columns.length === 0 || columns.length === report.columns.length) return report;

  return {
    ...report,
    columns,
    allColumns: report.columns,
    columnNote: `Columns: ${columns.length} of ${report.columns.length} shown`,
  };
}
