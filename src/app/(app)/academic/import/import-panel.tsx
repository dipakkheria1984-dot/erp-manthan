"use client";

import Link from "next/link";
import { Alert } from "@/components/ui";
import { BulkImportWizard, type BulkPreview } from "@/components/bulk-import-wizard";
import { commitAcademicImportAction, previewAcademicImportAction } from "./actions";

type Outcome = { departments: number; courses: number; batches: number };

/**
 * Matches the order `prepareAcademicImport` renders each row's cells in. Kept
 * here rather than imported, because that module is server-only.
 */
const COLUMNS = ["Code", "Name", "Details", "Status"];

export function AcademicImportPanel() {
  return (
    <BulkImportWizard<Outcome>
      previewAction={previewAcademicImportAction}
      commitAction={commitAcademicImportAction}
      // The wizard renders Sheet / Row / Status / Issues itself.
      columns={COLUMNS}
      accept=".xlsx"
      confirmLabel={(preview: BulkPreview) => `Import ${preview.validRows} row${preview.validRows === 1 ? "" : "s"}`}
      renderDone={(outcome) => (
        <div className="space-y-4">
          <Alert tone="success" title="Import complete">
            {outcome.departments} department(s), {outcome.courses} course(s) and {outcome.batches} batch(es) created.
            Each batch has its semesters laid out and its opening fee version recorded.
          </Alert>
          <div className="flex flex-wrap gap-4 text-sm">
            <Link href="/academic/departments" className="text-brand hover:underline">
              Departments
            </Link>
            <Link href="/academic/courses" className="text-brand hover:underline">
              Courses
            </Link>
            <Link href="/academic/batches" className="text-brand hover:underline">
              Batches
            </Link>
          </div>
        </div>
      )}
    />
  );
}
