import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getInstitute } from "@/lib/config";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { formatPaise } from "@/lib/money";
import { buildReport } from "@/lib/reports";
import { reportDefinition, type ReportColumn, type ReportRow, type ReportSection } from "@/lib/reports/types";
import { Alert, Card, EmptyState, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { WaiveLateFeeButton } from "@/components/waive-late-fee-button";
import { ReportFilters } from "./report-filters";
import { ExportButtons } from "./export-buttons";
import { ColumnPicker } from "./column-picker";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * A report cell. Columns carrying a `linkTemplate` — the Student Ledger's
 * receipt number, so a duplicate can be reprinted without leaving the ledger —
 * render as a link; everything else is plain text.
 */
function ReportCell({ column, value }: { column: ReportColumn; value: string | number | null }) {
  if (value === null || value === "") return <>—</>;
  if (!column.linkTemplate) return <>{value}</>;

  return (
    <a
      href={column.linkTemplate.replace("{value}", encodeURIComponent(String(value)))}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-brand hover:underline"
    >
      {value}
    </a>
  );
}

/**
 * The action a section offers on its rows — today only the Student Ledger's
 * outstanding installments, where the late fee can be written off without
 * leaving the report. The installment and its outstanding late fee ride on the
 * row without a column of their own, so a row that has neither (or nothing left
 * to waive) simply gets an empty cell.
 */
function RowAction({ action, row }: { action: ReportSection["rowAction"]; row: ReportRow }) {
  if (action !== "waive-late-fee") return null;

  const installmentId = row.installmentId;
  const lateFeePaise = row.lateFeeOutstandingPaise;
  if (typeof installmentId !== "string" || typeof lateFeePaise !== "number" || lateFeePaise <= 0) return null;

  return <WaiveLateFeeButton installmentId={installmentId} outstandingLateFeeLabel={formatPaise(lateFeePaise)} />;
}

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return { title: reportDefinition(key)?.title ?? "Report" };
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: SearchParams;
}) {
  const { key } = await params;
  const definition = reportDefinition(key);
  if (!definition) notFound();

  const user = await requireUser();
  if (!hasPermission(user.permissions, definition.permission)) {
    return (
      <>
        <PageHeader title={definition.title} />
        <Alert tone="danger" title="Not permitted">
          Your role does not grant access to this report.
        </Alert>
      </>
    );
  }

  const raw = await searchParams;
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const single = one(value);
    if (single) query[name] = single;
  }

  // The ledger is per-student, so it only runs once a student is chosen.
  const shouldRun = definition.key !== "ledger" || Boolean(query.studentId);
  const report = shouldRun ? await buildReport(key, query, user.permissions) : null;

  const institute = await getInstitute().catch(() => null);
  // A ledger belongs to one student, so their address is offered as the
  // recipient. Every other report is internal and starts blank.
  const ledgerStudent =
    key === "ledger" && query.studentId
      ? await prisma.student.findUnique({ where: { id: query.studentId }, select: { email: true } })
      : null;
  const ledgerStudentEmail = ledgerStudent?.email ?? null;

  // Waiving a late fee is a counter decision, and the ledger is where staff land
  // when a family queries the charge — so it is settled here too, not only on
  // the collection screen and the student record.
  const canWaiveLateFee = hasPermission(user.permissions, PERMISSIONS.FEE_WAIVE_LATE_FEE);

  const [departments, courses, batches, semesters, academicYears, collectors, students] = await Promise.all([
    definition.filters.includes("department")
      ? prisma.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, code: true } })
      : [],
    definition.filters.includes("course")
      ? prisma.course.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, code: true, departmentId: true } })
      : [],
    definition.filters.includes("batch")
      ? prisma.batch.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, code: true, courseId: true } })
      : [],
    definition.filters.includes("semester")
      ? prisma.semester.findMany({
          orderBy: [{ batchId: "asc" }, { semesterNumber: "asc" }],
          select: { id: true, semesterNumber: true, batchId: true, batch: { select: { code: true } } },
        })
      : [],
    definition.filters.includes("academicYear")
      ? prisma.academicYear.findMany({ orderBy: { startDate: "desc" }, select: { id: true, name: true } })
      : [],
    definition.filters.includes("collectedBy")
      ? prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
      : [],
    definition.filters.includes("student")
      ? prisma.student.findMany({
          orderBy: { studentCode: "asc" },
          select: { id: true, studentCode: true, fullName: true },
          take: 500,
        })
      : [],
  ]);

  return (
    <>
      <PageHeader
        title={definition.title}
        description={definition.description}
        actions={
          report ? (
            <ExportButtons
              reportKey={key}
              query={query}
              reportTitle={report.title}
              instituteName={institute?.name}
              suggestedTo={ledgerStudentEmail}
            />
          ) : null
        }
      />

      <div className="space-y-4">
        <Card title="Filters">
          <ReportFilters
            reportKey={key}
            filters={definition.filters}
            defaults={query}
            departments={departments.map((d) => ({ id: d.id, name: `${d.code} — ${d.name}` }))}
            courses={courses.map((c) => ({ id: c.id, name: `${c.code} — ${c.name}`, parentId: c.departmentId }))}
            batches={batches.map((b) => ({ id: b.id, name: `${b.code} — ${b.name}`, parentId: b.courseId }))}
            semesters={semesters.map((s) => ({
              id: s.id,
              name: `${s.batch.code} · Semester ${s.semesterNumber}`,
              parentId: s.batchId,
            }))}
            academicYears={academicYears}
            collectors={collectors}
            students={students.map((s) => ({ id: s.id, name: `${s.studentCode} — ${s.fullName}` }))}
          />
        </Card>

        {!report ? (
          <EmptyState
            title="Choose a student"
            description="The Student Ledger is a per-student transaction history — pick a student above to run it."
          />
        ) : (
          <Card
            title={report.title}
            description={`${report.rows.length} row(s)`}
            actions={
              <ColumnPicker
                reportKey={key}
                query={query}
                // `allColumns` is only set once something is hidden, so on a
                // full report the visible list is the complete one.
                allColumns={report.allColumns ?? report.columns}
                visibleKeys={report.columns.map((column) => column.key)}
              />
            }
          >
            {report.notes?.length ? (
              <div className="mb-4 space-y-2">
                {report.notes.map((note, i) => (
                  <Alert key={i} tone="info">
                    {note}
                  </Alert>
                ))}
              </div>
            ) : null}

            {report.filterSummary.length > 0 ? (
              <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {report.filterSummary.map((line, i) => (
                  <span key={i}>{line}</span>
                ))}
              </div>
            ) : null}

            {report.rows.length === 0 ? (
              <EmptyState title="No rows matched these filters." />
            ) : (
              <TableWrap>
                <thead>
                  <tr>
                    {report.columns.map((column) => (
                      <Th key={column.key} className={column.align === "right" ? "text-right" : undefined}>
                        {column.header}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row, index) => (
                    <Tr key={index}>
                      {report.columns.map((column) => (
                        <Td
                          key={column.key}
                          className={column.align === "right" ? "text-right tabular-nums" : undefined}
                        >
                          <ReportCell column={column} value={row[column.key]} />
                        </Td>
                      ))}
                    </Tr>
                  ))}
                  {report.totals ? (
                    <tr className="bg-background font-semibold">
                      {report.columns.map((column) => (
                        <Td
                          key={column.key}
                          className={column.align === "right" ? "text-right tabular-nums" : undefined}
                        >
                          {report.totals?.[column.key] ?? ""}
                        </Td>
                      ))}
                    </tr>
                  ) : null}
                </tbody>
              </TableWrap>
            )}
          </Card>
        )}

        {report?.sections?.map((section) => {
          // The action column is on screen only, and only for a viewer allowed
          // to take the action — everyone else sees the plain table.
          const showActions = section.rowAction === "waive-late-fee" && canWaiveLateFee;

          return (
            <Card key={section.title} title={section.title} description={section.description}>
              {section.rows.length === 0 ? (
                <EmptyState title={section.emptyMessage ?? "Nothing to show."} />
              ) : (
                <TableWrap>
                  <thead>
                    <tr>
                      {section.columns.map((column) => (
                        <Th key={column.key} className={column.align === "right" ? "text-right" : undefined}>
                          {column.header}
                        </Th>
                      ))}
                      {showActions ? <Th>Action</Th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.map((row, index) => (
                      <Tr key={index}>
                        {section.columns.map((column) => (
                          <Td
                            key={column.key}
                            className={column.align === "right" ? "text-right tabular-nums" : undefined}
                          >
                            <ReportCell column={column} value={row[column.key]} />
                          </Td>
                        ))}
                        {showActions ? (
                          <Td>
                            <RowAction action={section.rowAction} row={row} />
                          </Td>
                        ) : null}
                      </Tr>
                    ))}
                    {section.totals ? (
                      <tr className="bg-background font-semibold">
                        {section.columns.map((column) => (
                          <Td
                            key={column.key}
                            className={column.align === "right" ? "text-right tabular-nums" : undefined}
                          >
                            {section.totals?.[column.key] ?? ""}
                          </Td>
                        ))}
                        {showActions ? <Td /> : null}
                      </tr>
                    ) : null}
                  </tbody>
                </TableWrap>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
