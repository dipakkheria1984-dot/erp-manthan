import "server-only";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { hasPermission } from "@/lib/permissions";
import { courseWiseReport, departmentWiseReport, studentRecordsReport } from "./academic";
import { feeCollectionReport, feeDueReport, ledgerReport } from "./fees";
import {
  COLUMNS_PARAM,
  reportDefinition,
  selectColumns,
  type ReportKey,
  type ReportParams,
  type ReportResult,
} from "./types";

export * from "./types";

/**
 * Single entry point for every report. Access is role-based per report (spec 7),
 * and the viewer's column choice is applied here too, so the on-screen table and
 * the export routes can never diverge on either.
 */
export async function buildReport(
  key: string,
  params: ReportParams,
  permissions: readonly string[],
): Promise<ReportResult> {
  const definition = reportDefinition(key);
  if (!definition) throw new NotFoundError("Report");
  if (!hasPermission(permissions, definition.permission)) throw new ForbiddenError();

  const report = await runReport(definition.key, params);
  return selectColumns(report, params[COLUMNS_PARAM]);
}

function runReport(key: ReportKey, params: ReportParams): Promise<ReportResult> {
  switch (key) {
    case "student-records":
      return studentRecordsReport(params);
    case "department-wise":
      return departmentWiseReport(params);
    case "course-wise":
      return courseWiseReport(params);
    case "ledger":
      return ledgerReport(params);
    case "fee-collection":
      return feeCollectionReport(params);
    case "fee-due":
      return feeDueReport(params);
  }
}
