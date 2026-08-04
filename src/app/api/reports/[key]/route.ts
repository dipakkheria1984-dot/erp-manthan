import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getInstitute } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { buildReport, type ReportParams } from "@/lib/reports";
import { reportToCsv, reportToExcel, reportToPdf } from "@/lib/reports/export";

/**
 * Export a report as PDF, Excel or CSV. Access is checked inside `buildReport`,
 * so the export route can never expose a report the user cannot see on screen.
 *
 *   /api/reports/fee-collection?format=xlsx&from=2026-04-01&to=2026-06-30
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { key } = await params;
  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();

  const reportParams: ReportParams = {};
  for (const [name, value] of url.searchParams.entries()) {
    if (name !== "format" && value) reportParams[name] = value;
  }

  try {
    const [report, institute] = await Promise.all([
      buildReport(key, reportParams, user.permissions),
      getInstitute(),
    ]);

    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${key}-${stamp}`;

    if (format === "pdf") {
      const buffer = await reportToPdf(report, institute);
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `inline; filename="${base}.pdf"`,
          "cache-control": "private, no-store",
        },
      });
    }

    if (format === "xlsx" || format === "excel") {
      const buffer = await reportToExcel(report, institute);
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="${base}.xlsx"`,
          "cache-control": "private, no-store",
        },
      });
    }

    const csv = reportToCsv(report, institute);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${base}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[report-export]", error);
    return NextResponse.json({ error: "Could not generate the report." }, { status: 500 });
  }
}
