import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { REPORT_DEFINITIONS } from "@/lib/reports/types";
import { Alert, Card, EmptyState, PageHeader } from "@/components/ui";

export const metadata = { title: "Reports" };

export default async function ReportsIndexPage() {
  const user = await requireUser();
  const available = REPORT_DEFINITIONS.filter((report) => hasPermission(user.permissions, report.permission));

  return (
    <>
      <PageHeader
        title="Reporting suite"
        description="Every report supports a custom date range, its own filters, and PDF / Excel / CSV export. Exports carry a header showing the report name, the filters applied and the generation timestamp."
      />

      {available.length === 0 ? (
        <EmptyState
          title="No reports available"
          description="Your role does not grant access to any report. Ask an Admin to review your permissions."
        />
      ) : (
        <>
          <div className="mb-4">
            <Alert tone="info">
              Dropped-out and expelled students are excluded from active counts by default and appear only when you
              filter for them explicitly. Cancelled receipts are excluded from Fee Collection but remain visible in the
              Student Ledger.
            </Alert>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {available.map((report) => (
              <Link key={report.key} href={`/reports/${report.key}`} className="block">
                <Card className="h-full transition-colors hover:border-brand">
                  <h2 className="text-base font-semibold text-brand">{report.title}</h2>
                  <p className="mt-1 text-sm text-muted">{report.description}</p>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}
