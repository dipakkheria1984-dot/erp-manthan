"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { FormFeedback, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Alert, Badge, Button, Field, Input, StatTile, TableWrap, Td, Th, Tr } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { commitImportAction, previewImportAction } from "./actions";

type Issue = { field?: string; message: string };
type PreviewRow = {
  rowNumber: number;
  raw: Record<string, string>;
  errors: Issue[];
  warnings: Issue[];
  opening: { count: number; totalPaise: number };
  resolved?: unknown;
};
type Preview = {
  fileName: string;
  storagePath: string;
  totalRows: number;
  validRows: number;
  rows: PreviewRow[];
};

export function ImportWizard() {
  const [previewState, previewAction] = useActionState<FormState, FormData>(previewImportAction, null);
  const [commitState, commitAction] = useActionState<FormState, FormData>(commitImportAction, null);
  const [showOnlyProblems, setShowOnlyProblems] = useState(false);

  const preview = previewState?.ok ? (previewState.data as Preview) : null;
  const committed = commitState?.ok ? (commitState.data as { created: number; skipped: number }) : null;

  if (committed) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Import complete">
          {committed.created} student(s) created
          {committed.skipped > 0 ? `, ${committed.skipped} row(s) with errors skipped` : ""}.
        </Alert>
        <div className="flex gap-2">
          <Link href="/students" className="text-sm text-brand hover:underline">
            View students
          </Link>
        </div>
      </div>
    );
  }

  const rejected = preview ? preview.totalRows - preview.validRows : 0;
  const visibleRows = preview
    ? showOnlyProblems
      ? preview.rows.filter((row) => row.errors.length > 0 || row.warnings.length > 0)
      : preview.rows
    : [];

  return (
    <div className="space-y-6">
      <form action={previewAction} className="space-y-4">
        <FormFeedback state={previewState} />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Import file" htmlFor="file" required error={fieldError(previewState, "file")} className="min-w-72 flex-1">
            <Input id="file" name="file" type="file" accept=".csv,.xlsx" required />
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

          {rejected > 0 ? (
            <Alert tone="warning" title={`${rejected} row(s) will be skipped`}>
              Fix them in the source file and upload it again if you need them. Valid rows can be imported now —
              re-importing the corrected rows later is safe as long as you remove the ones that already went in.
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
                <Th className="w-16">Row</Th>
                <Th>Name</Th>
                <Th>Placement</Th>
                <Th>LF No</Th>
                <Th>Outstanding</Th>
                <Th>Status</Th>
                <Th>Issues</Th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <Td colSpan={7} className="text-center text-muted">
                    Nothing to show.
                  </Td>
                </tr>
              ) : (
                visibleRows.map((row) => (
                  <Tr key={row.rowNumber} className={row.errors.length > 0 ? "bg-red-50/40" : undefined}>
                    <Td className="tabular-nums">{row.rowNumber}</Td>
                    <Td className="font-medium">{row.raw.fullName || "—"}</Td>
                    <Td className="text-muted">
                      {[row.raw.departmentCode, row.raw.courseCode, row.raw.batchCode].filter(Boolean).join(" / ") ||
                        "—"}
                      {row.raw.semesterNumber ? ` · sem ${row.raw.semesterNumber}` : ""}
                    </Td>
                    <Td className="font-mono text-xs">{row.raw.lfNo || "auto"}</Td>
                    <Td className="tabular-nums">
                      {row.opening.count === 0 ? (
                        "—"
                      ) : (
                        <>
                          {formatPaise(row.opening.totalPaise)}
                          <span className="block text-xs text-muted">
                            {row.opening.count} installment{row.opening.count === 1 ? "" : "s"}
                          </span>
                        </>
                      )}
                    </Td>
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
                          {row.errors.map((issue, i) => (
                            <li key={`e${i}`} className="text-xs text-danger">
                              {issue.field ? <span className="font-medium">{issue.field}: </span> : null}
                              {issue.message}
                            </li>
                          ))}
                          {row.warnings.map((issue, i) => (
                            <li key={`w${i}`} className="text-xs text-warning">
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

          <form action={commitAction} className="space-y-3 border-t border-border pt-4">
            <FormFeedback state={commitState} />
            <input type="hidden" name="storagePath" value={preview.storagePath} />
            <input type="hidden" name="fileName" value={preview.fileName} />
            <SubmitButton disabled={preview.validRows === 0} pendingLabel="Importing…">
              Import {preview.validRows} student{preview.validRows === 1 ? "" : "s"}
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
