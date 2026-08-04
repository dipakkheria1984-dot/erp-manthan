import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { BATCH_COLUMNS, COURSE_COLUMNS, DEPARTMENT_COLUMNS, SHEETS } from "@/lib/imports/academic";
import { env } from "@/lib/env";
import { Alert, Card, PageHeader, TableWrap, Td, Th, Tr, buttonClass } from "@/components/ui";
import { AcademicImportPanel } from "./import-panel";

export const metadata = { title: "Bulk import academic structure" };

const SECTIONS = [
  { sheet: SHEETS.departments.name, columns: DEPARTMENT_COLUMNS },
  { sheet: SHEETS.courses.name, columns: COURSE_COLUMNS },
  { sheet: SHEETS.batches.name, columns: BATCH_COLUMNS },
];

export default async function AcademicImportPage() {
  await requirePermission(PERMISSIONS.ACADEMIC_MANAGE);

  return (
    <>
      <PageHeader
        title="Bulk import academic structure"
        description="Set up departments, courses and batches from one workbook."
        actions={
          <a href="/api/templates/academic-import" className={buttonClass("secondary", "sm")}>
            Download template
          </a>
        }
      />

      <div className="space-y-6">
        <Alert tone="warning" title="What this does and does not do">
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              One workbook, three sheets — <strong>Departments</strong>, <strong>Courses</strong>,{" "}
              <strong>Batches</strong> — applied in that order, so a course can name a department created on the sheet
              before it and a batch can name a course created on the sheet before it.
            </li>
            <li>
              Each batch also gets its <strong>semesters laid out</strong> across the batch window and its preset
              tuition recorded as the opening fee version, exactly as creating one by hand does.
            </li>
            <li>
              This <strong>creates only</strong>. A code that already exists is reported as an error rather than
              overwritten — edit existing records on their own screens, where the rules about changing a semester count
              or deactivating something with students attached apply.
            </li>
            <li>
              Exam and activity fees are <strong>not</strong> set here. They are per semester and are entered on the
              batch screen once the batch exists.
            </li>
            <li>Nothing is written until you review the preview and confirm.</li>
          </ul>
        </Alert>

        <Card title="Upload" description={`Excel workbook, up to ${env.maxUploadMb} MB. Use the template's sheet names and header rows.`}>
          <AcademicImportPanel />
        </Card>

        {SECTIONS.map((section) => (
          <Card key={section.sheet} title={`${section.sheet} sheet`}>
            <TableWrap>
              <thead>
                <tr>
                  <Th className="w-52">Column</Th>
                  <Th className="w-24">Required</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {section.columns.map((column) => (
                  <Tr key={column.key}>
                    <Td className="font-medium">{column.header}</Td>
                    <Td className={column.required ? "text-danger" : "text-muted"}>
                      {column.required ? "Required" : "Optional"}
                    </Td>
                    <Td className="text-muted">{column.help || "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>
        ))}
      </div>
    </>
  );
}
