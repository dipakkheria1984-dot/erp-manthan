import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { IMPORT_COLUMNS } from "@/lib/student-import";
import { env } from "@/lib/env";
import { Alert, Card, PageHeader, TableWrap, Td, Th, Tr, buttonClass } from "@/components/ui";
import { ImportWizard } from "./import-wizard";

export const metadata = { title: "Bulk import students" };

export default async function StudentImportPage() {
  await requirePermission(PERMISSIONS.STUDENT_IMPORT);

  // Codes are what the file must reference, so show them alongside the form.
  const [departments, courses, batches] = await Promise.all([
    prisma.department.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true } }),
    prisma.course.findMany({
      orderBy: { code: "asc" },
      select: { code: true, name: true, department: { select: { code: true } } },
    }),
    prisma.batch.findMany({
      orderBy: { code: "asc" },
      select: {
        code: true,
        name: true,
        totalSeats: true,
        course: { select: { code: true } },
        _count: { select: { students: true } },
      },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Bulk import students"
        description="For migrating existing student data. Rows land directly as enrolled students — this is not the admission workflow."
        actions={
          <>
            <a href="/api/templates/student-import?format=xlsx" className={buttonClass("secondary", "sm")}>
              Template (Excel)
            </a>
            <a href="/api/templates/student-import?format=csv" className={buttonClass("secondary", "sm")}>
              Template (CSV)
            </a>
          </>
        }
      />

      <div className="space-y-6">
        <Alert tone="warning" title="What this does and does not do">
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              Each row creates an <strong>active student</strong> plus a backing application record marked as migrated,
              so the audit trail records how they entered the system.
            </li>
            <li>
              An <strong>Outstanding Amount</strong> is carried in as an opening-balance installment, so the ledger,
              the Fee Due report and reminders are complete from day one. A student part-way through a payment plan can
              carry several: fill <strong>Outstanding Amount 2</strong>, <strong>3</strong> and so on, each with its own
              due date. Leave them blank for students who owe nothing.
            </li>
            <li>
              Ongoing semester fees are <strong>not</strong> imported — those are created by the promotion run when the
              cohort moves to its next semester.
            </li>
            <li>Nothing is written until you review the preview and confirm.</li>
          </ul>
        </Alert>

        <Card title="Upload" description={`CSV or XLSX, up to ${env.maxUploadMb} MB. Use the template's header row.`}>
          <ImportWizard />
        </Card>

        <Card title="Columns">
          <TableWrap>
            <thead>
              <tr>
                <Th>Column</Th>
                <Th className="w-24">Required</Th>
                <Th>Notes</Th>
              </tr>
            </thead>
            <tbody>
              {IMPORT_COLUMNS.map((column) => (
                <Tr key={column.key}>
                  <Td className="font-medium">{column.header}</Td>
                  <Td>{column.required ? <span className="text-danger">Required</span> : "Optional"}</Td>
                  <Td className="text-muted">{column.help || "—"}</Td>
                </Tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Department codes">
            <ul className="space-y-1 text-sm">
              {departments.map((d) => (
                <li key={d.code}>
                  <span className="font-mono text-xs">{d.code}</span> — {d.name}
                </li>
              ))}
              {departments.length === 0 ? <li className="text-muted">None yet.</li> : null}
            </ul>
          </Card>
          <Card title="Course codes">
            <ul className="space-y-1 text-sm">
              {courses.map((c) => (
                <li key={c.code}>
                  <span className="font-mono text-xs">{c.code}</span> — {c.name}{" "}
                  <span className="text-muted">({c.department.code})</span>
                </li>
              ))}
              {courses.length === 0 ? <li className="text-muted">None yet.</li> : null}
            </ul>
          </Card>
          <Card title="Batch codes">
            <ul className="space-y-1 text-sm">
              {batches.map((b) => (
                <li key={b.code}>
                  <span className="font-mono text-xs">{b.code}</span> — {b.name}{" "}
                  <span className="text-muted">
                    ({b._count.students}/{b.totalSeats} seats)
                  </span>
                </li>
              ))}
              {batches.length === 0 ? <li className="text-muted">None yet.</li> : null}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
