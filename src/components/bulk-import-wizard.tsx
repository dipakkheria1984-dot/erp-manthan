"use client";

import { useActionState, useState, type ReactNode } from "react";
import { FormFeedback, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Alert, Badge, Button, Field, Input, StatTile, TableWrap, Td, Th, Tr } from "@/components/ui";

/**
 * Upload → preview → confirm, driven entirely by the preview the server returns.
 *
 * Each importer renders its own cells into `display`, so this component does not
 * need to know whether it is showing departments or receipts. Nothing is written
 * until the second form is submitted, and the file is re-validated at that point.
 */

type Issue = { field?: string; message: string };

export type BulkPreviewRow = {
  rowNumber: number;
  /** Optional grouping label, e.g. the workbook sheet a row came from. */
  sheet?: string;
  display: string[];
  errors: Issue[];
  warnings: Issue[];
};

export type BulkPreview = {
  fileName: string;
  storagePath: string;
  totalRows: number;
  validRows: number;
  rows: BulkPreviewRow[];
};

export function BulkImportWizard<TResult>({
  previewAction: previewFn,
  commitAction: commitFn,
  columns,
  accept = ".csv,.xlsx",
  confirmLabel,
  renderStats,
  renderDone,
}: {
  previewAction: (prev: unknown, formData: FormData) => Promise<FormState>;
  commitAction: (prev: unknown, formData: FormData) => Promise<FormState>;
  /** Headers for the preview table, excluding Row / Status / Issues. */
  columns: string[];
  accept?: string;
  confirmLabel: (preview: BulkPreview) => string;
  /** Extra tiles shown above the preview table. */
  renderStats?: (preview: BulkPreview) => ReactNode;
  renderDone: (result: TResult) => ReactNode;
}) {
  const [previewState, runPreview] = useActionState<FormState, FormData>(previewFn, null);
  const [commitState, runCommit] = useActionState<FormState, FormData>(commitFn, null);
  const [showOnlyProblems, setShowOnlyProblems] = useState(false);

  const preview = previewState?.ok ? (previewState.data as BulkPreview) : null;
  const committed = commitState?.ok ? (commitState.data as TResult) : null;

  if (committed) return <>{renderDone(committed)}</>;

  const rejected = preview ? preview.totalRows - preview.validRows : 0;
  const visibleRows = preview
    ? showOnlyProblems
      ? preview.rows.filter((row) => row.errors.length > 0 || row.warnings.length > 0)
      : preview.rows
    : [];
  const hasSheets = Boolean(preview?.rows.some((row) => row.sheet));
  const columnCount = columns.length + (hasSheets ? 4 : 3);

  return (
    <div className="space-y-6">
      <form action={runPreview} className="space-y-4">
        <FormFeedback state={previewState} />
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Import file"
            htmlFor="file"
            required
            error={fieldError(previewState, "file")}
            className="min-w-72 flex-1"
          >
            <Input id="file" name="file" type="file" accept={accept} required />
          </Field>
          <SubmitButton pendingLabel="Checking…">Validate file</SubmitButton>
        </div>
      </form>

      {preview ? (
        <div className="space-y-4 border-t border-border pt-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label="Rows found" value={preview.totalRows} hint={preview.fileName} />
            <StatTile label="Ready to import" value={preview.validRows} tone="success" />
            <StatTile
              label="Will be skipped"
              value={rejected}
              tone={rejected > 0 ? "danger" : "default"}
              hint={rejected > 0 ? "Rows with errors" : "No errors"}
            />
          </div>

          {renderStats?.(preview)}

          {rejected > 0 ? (
            <Alert tone="warning" title={`${rejected} row(s) will be skipped`}>
              Fix them in the source file and upload it again if you need them. Valid rows can be imported now.
            </Alert>
          ) : null}

          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setShowOnlyProblems((v) => !v)}>
              {showOnlyProblems ? "Show all rows" : "Show only rows with issues"}
            </Button>
            <span className="text-xs text-muted">
              Showing {visibleRows.length} of {preview.totalRows}
            </span>
          </div>

          <TableWrap>
            <thead>
              <tr>
                {hasSheets ? <Th className="w-28">Sheet</Th> : null}
                <Th className="w-16">Row</Th>
                {columns.map((column) => (
                  <Th key={column}>{column}</Th>
                ))}
                {/* "Result", not "Status": an imported record may have a status of its own. */}
                <Th>Result</Th>
                <Th>Issues</Th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <Td colSpan={columnCount} className="text-center text-muted">
                    Nothing to show.
                  </Td>
                </tr>
              ) : (
                visibleRows.map((row, i) => (
                  <Tr key={`${row.sheet ?? ""}-${row.rowNumber}-${i}`} className={row.errors.length > 0 ? "bg-red-50/40" : undefined}>
                    {hasSheets ? <Td className="text-muted">{row.sheet ?? "—"}</Td> : null}
                    <Td className="tabular-nums">{row.rowNumber}</Td>
                    {columns.map((column, index) => (
                      <Td key={column} className={index === 0 ? "font-medium" : "text-muted"}>
                        {row.display[index] ?? "—"}
                      </Td>
                    ))}
                    <Td>
                      {row.errors.length > 0 ? (
                        <Badge tone="danger">Skipped</Badge>
                      ) : row.warnings.length > 0 ? (
                        <Badge tone="warning">Import with warnings</Badge>
                      ) : (
                        <Badge tone="success">Ready</Badge>
                      )}
                    </Td>
                    <Td>
                      {row.errors.length === 0 && row.warnings.length === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {row.errors.map((issue, index) => (
                            <li key={`e${index}`} className="text-xs text-danger">
                              {issue.field ? <span className="font-medium">{issue.field}: </span> : null}
                              {issue.message}
                            </li>
                          ))}
                          {row.warnings.map((issue, index) => (
                            <li key={`w${index}`} className="text-xs text-warning">
                              {issue.field ? <span className="font-medium">{issue.field}: </span> : null}
                              {issue.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </TableWrap>

          <form action={runCommit} className="space-y-3 border-t border-border pt-4">
            <FormFeedback state={commitState} />
            <input type="hidden" name="storagePath" value={preview.storagePath} />
            <input type="hidden" name="fileName" value={preview.fileName} />
            <SubmitButton disabled={preview.validRows === 0} pendingLabel="Importing…">
              {confirmLabel(preview)}
            </SubmitButton>
            <p className="text-xs text-muted">
              The file is re-validated at this point, so anything that changed in the meantime is caught before
              anything is written.
            </p>
          </form>
        </div>
      ) : null}
    </div>
  );
}
