"use client";

import { buttonClass } from "@/components/ui";
import { EmailDocumentButton } from "@/components/email-document-button";

/**
 * Export links carry the current filters through to the API route so the file
 * always matches what is on screen. The Email button passes the same filters to
 * the server, which rebuilds the report and attaches it.
 */
export function ExportButtons({
  reportKey,
  query,
  reportTitle,
  instituteName,
  suggestedTo,
}: {
  reportKey: string;
  query: Record<string, string>;
  reportTitle: string;
  instituteName?: string;
  /** The student's address on a Student Ledger; nothing on the other reports. */
  suggestedTo?: string | null;
}) {
  const href = (format: string) => {
    const params = new URLSearchParams(query);
    params.set("format", format);
    return `/api/reports/${reportKey}?${params.toString()}`;
  };

  return (
    <div className="flex flex-wrap gap-2">
      <a href={href("pdf")} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
        PDF
      </a>
      <a href={href("xlsx")} className={buttonClass("secondary", "sm")}>
        Excel
      </a>
      <a href={href("csv")} className={buttonClass("secondary", "sm")}>
        CSV
      </a>
      <EmailDocumentButton
        target={{ kind: "report", reportKey, query }}
        size="sm"
        label="Email"
        allowFormatChoice
        defaultTo={suggestedTo}
        defaultSubject={`${reportTitle}${instituteName ? ` — ${instituteName}` : ""}`}
        defaultMessage={
          `Please find attached: ${reportTitle}.` + (instituteName ? `\n\n— ${instituteName}` : "")
        }
      />
    </div>
  );
}
