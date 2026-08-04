import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { RECEIPT_COLUMNS } from "@/lib/imports/receipts";
import { env } from "@/lib/env";
import { Alert, Card, PageHeader, TableWrap, Td, Th, Tr, buttonClass } from "@/components/ui";
import { ReceiptImportPanel } from "./import-panel";

export const metadata = { title: "Bulk import receipts" };

export default async function ReceiptImportPage() {
  await requirePermission(PERMISSIONS.FEE_COLLECT);

  return (
    <>
      <PageHeader
        title="Bulk import receipts"
        description="For money already collected — migrated from the old system, or captured offline."
        actions={
          <>
            <a href="/api/templates/receipt-import?format=xlsx" className={buttonClass("secondary", "sm")}>
              Template (Excel)
            </a>
            <a href="/api/templates/receipt-import?format=csv" className={buttonClass("secondary", "sm")}>
              Template (CSV)
            </a>
          </>
        }
      />

      <div className="space-y-6">
        <Alert tone="warning" title="What this does and does not do">
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              Each row behaves exactly like one collection on the Collect Fees screen: the amount settles installments{" "}
              <strong>oldest due date first</strong>, clearing any late fee on an installment before its principal.
            </li>
            <li>
              Rows are applied in <strong>payment-date order</strong>, so late fees are assessed as they actually
              accrued. Several rows may pay the same student — the preview accounts for the earlier ones, so it will
              tell you if they overshoot together.
            </li>
            <li>
              The old system&apos;s <strong>receipt number is kept</strong> when you supply one. Left blank, this
              system&apos;s own sequence assigns the next number.
            </li>
            <li>
              A student must exist and be Active or Passed. Import their fee plan first — a student with nothing
              outstanding has nothing for a receipt to settle.
            </li>
            <li>Nothing is written until you review the preview and confirm.</li>
          </ul>
        </Alert>

        <Card title="Upload" description={`CSV or XLSX, up to ${env.maxUploadMb} MB. Use the template's header row.`}>
          <ReceiptImportPanel />
        </Card>

        <Card title="Column guide">
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-44">Column</Th>
                <Th className="w-24">Required</Th>
                <Th>Notes</Th>
              </tr>
            </thead>
            <tbody>
              {RECEIPT_COLUMNS.map((column) => (
                <Tr key={column.key}>
                  <Td className="font-medium">
                    {column.header}
                    {column.aliases?.length ? (
                      <span className="mt-0.5 block text-xs font-normal text-muted">
                        or {column.aliases.join(", ")}
                      </span>
                    ) : null}
                  </Td>
                  <Td className={column.required ? "text-danger" : "text-muted"}>
                    {column.required ? "Required" : "Optional"}
                  </Td>
                  <Td className="text-muted">{column.help || "—"}</Td>
                </Tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
      </div>
    </>
  );
}
