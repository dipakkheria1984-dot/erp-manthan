"use client";

import Link from "next/link";
import { Alert, StatTile } from "@/components/ui";
import { BulkImportWizard, type BulkPreview } from "@/components/bulk-import-wizard";
import { formatPaise } from "@/lib/money";
import { commitReceiptImportAction, previewReceiptImportAction } from "./actions";

type Outcome = { created: number; totalPaise: number };

/**
 * Matches the order `prepareReceiptImport` renders each row's cells in. Kept
 * here rather than imported, because that module is server-only.
 */
const COLUMNS = ["Receipt", "Student", "Name", "Date", "Amount", "Settles"];

export function ReceiptImportPanel() {
  return (
    <BulkImportWizard<Outcome>
      previewAction={previewReceiptImportAction}
      commitAction={commitReceiptImportAction}
      // The wizard renders Row / Status / Issues itself.
      columns={COLUMNS}
      confirmLabel={(preview: BulkPreview) => `Import ${preview.validRows} receipt${preview.validRows === 1 ? "" : "s"}`}
      renderStats={(preview) => {
        const total = (preview as BulkPreview & { totalPaise?: number }).totalPaise ?? 0;
        return (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label="Total to be collected" value={formatPaise(total)} tone="success" />
          </div>
        );
      }}
      renderDone={(outcome) => (
        <div className="space-y-4">
          <Alert tone="success" title="Import complete">
            {outcome.created} receipt(s) created, totalling {formatPaise(outcome.totalPaise)}. Installment statuses and
            late fees have been recalculated.
          </Alert>
          <div className="flex flex-wrap gap-4 text-sm">
            <Link href="/fees/receipts" className="text-brand hover:underline">
              Receipts register
            </Link>
            <Link href="/reports/fee-collection" className="text-brand hover:underline">
              Fee Collection report
            </Link>
          </div>
        </div>
      )}
    />
  );
}
