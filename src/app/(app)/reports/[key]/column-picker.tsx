"use client";

import { useState } from "react";
import { Button, Checkbox } from "@/components/ui";
import { Modal } from "@/components/form";
import { COLUMNS_PARAM, serialiseColumnSelection, type ReportColumn } from "@/lib/reports/types";

/**
 * Add/remove columns on a report.
 *
 * The choice is submitted as an ordinary GET alongside the current filters, so
 * it lands in the URL — which means the export links pick it up for free and a
 * particular view of a report can be bookmarked or shared.
 *
 * Checkboxes carry no `name`: they drive local state only, and the single
 * hidden `columns` field is what gets submitted. Repeated `columns=` params
 * would otherwise arrive as an array and be discarded by the page.
 */
export function ColumnPicker({
  reportKey,
  query,
  allColumns,
  visibleKeys,
}: {
  reportKey: string;
  /** The filters currently in the URL, carried through so they survive. */
  query: Record<string, string>;
  allColumns: ReportColumn[];
  visibleKeys: string[];
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>(visibleKeys);

  const toggle = (key: string) =>
    setChosen((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  const hiddenCount = allColumns.length - visibleKeys.length;

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Columns
        <span className="ml-1 text-muted">
          {visibleKeys.length}/{allColumns.length}
        </span>
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Columns"
        description="Choose what this report shows. Exports follow the same choice."
      >
        <form method="get" action={`/reports/${reportKey}`} className="space-y-4">
          {Object.entries(query)
            .filter(([name]) => name !== COLUMNS_PARAM)
            .map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
          <input
            type="hidden"
            name={COLUMNS_PARAM}
            // Empty when everything is ticked, so a full report has a clean URL
            // and stays full even if a column is added to it later.
            value={serialiseColumnSelection(chosen, allColumns)}
          />

          <div className="flex flex-wrap gap-2 border-b border-border pb-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => setChosen(allColumns.map((c) => c.key))}>
              Select all
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setChosen([])}>
              Clear
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setChosen(visibleKeys)}>
              Reset
            </Button>
          </div>

          <div className="max-h-80 space-y-1 overflow-y-auto">
            {allColumns.map((column) => (
              <label
                key={column.key}
                className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-sm hover:bg-background"
              >
                <Checkbox checked={chosen.includes(column.key)} onChange={() => toggle(column.key)} />
                <span>{column.header}</span>
              </label>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
            <p className="text-xs text-muted">
              {chosen.length === 0
                ? "Select at least one column."
                : `${chosen.length} of ${allColumns.length} selected`}
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={chosen.length === 0}>
                Apply
              </Button>
            </div>
          </div>
        </form>
      </Modal>

      {hiddenCount > 0 ? (
        <span className="text-xs text-muted">
          {hiddenCount} column{hiddenCount === 1 ? "" : "s"} hidden
        </span>
      ) : null}
    </>
  );
}
