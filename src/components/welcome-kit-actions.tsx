"use client";

import { useState } from "react";
import { Button, buttonClass } from "@/components/ui";
import { EmailDocumentButton } from "@/components/email-document-button";

/**
 * View / download / share controls for the approved-admission welcome kit
 * (spec 1.4 step 9).
 *
 * The PDF is served behind the same session as the rest of the app, so the
 * copied link only opens for signed-in staff. Families are either emailed the
 * kit straight from here — attached, not linked — or handed the downloaded file.
 */
export function WelcomeKitActions({
  applicationId,
  size = "md",
  studentName,
  studentCode,
  instituteName,
  defaultTo,
}: {
  applicationId: string;
  size?: "sm" | "md";
  studentName?: string;
  studentCode?: string;
  instituteName?: string;
  /** The family's address on file, prefilled and always editable. */
  defaultTo?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const href = `/api/applications/${applicationId}/welcome-kit`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (insecure origin, denied permission) —
      // the two links either side of this button still work.
      setCopied(false);
    }
  }

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <a href={href} target="_blank" rel="noreferrer" className={buttonClass("primary", size)}>
        View &amp; print
      </a>
      <a href={`${href}?download=1`} className={buttonClass("secondary", size)}>
        Download PDF
      </a>
      <EmailDocumentButton
        target={{ kind: "welcome-kit", applicationId }}
        size={size}
        label="Email kit"
        defaultTo={defaultTo}
        defaultSubject={
          instituteName
            ? `Welcome to ${instituteName} — admission confirmed${studentCode ? ` (${studentCode})` : ""}`
            : "Your welcome kit"
        }
        defaultMessage={
          `Dear ${studentName ?? "student"},\n\n` +
          `Your admission is confirmed${studentCode ? `. Your Student ID is ${studentCode}` : ""}.\n\n` +
          "Attached is your welcome kit: the admission confirmation letter, your admission form, the year-wise fee " +
          "payment plan, the terms & conditions, and your registration fee receipt.\n\n" +
          "Please keep it for your records." +
          (instituteName ? `\n\n— ${instituteName}` : "")
        }
      />
      <Button type="button" variant="ghost" size={size} onClick={copyLink}>
        {copied ? "Link copied" : "Copy link"}
      </Button>
    </div>
  );
}
