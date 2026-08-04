"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { getCommunicationConfig } from "@/lib/config";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { prepareDocument, type EmailableDocument } from "@/lib/email-documents";
import { emailIsLive } from "@/lib/notification-providers";
import { deliverEmail } from "@/lib/notifications";
import { formObject, requiredText } from "@/lib/validation";

/**
 * Email a generated document — welcome kit, fee receipt, report or student
 * ledger — as an attachment.
 *
 * Shared by every "Email" button in the app. The form carries only identifiers;
 * the document itself is rebuilt server-side by `prepareDocument`, which also
 * enforces the same permission the on-screen route does.
 */

const emailSchema = z.object({
  docKind: z.enum(["welcome-kit", "receipt", "report"]),
  applicationId: z.string().trim().optional(),
  receiptId: z.string().trim().optional(),
  reportKey: z.string().trim().optional(),
  reportQuery: z.string().trim().optional(),
  format: z.enum(["pdf", "xlsx", "csv"]).optional(),
  to: requiredText("Recipient email").email("Enter a valid email address."),
  subject: requiredText("Subject", 2),
  message: requiredText("Message", 2),
});

/** The report filters travel as JSON; anything malformed becomes no filters. */
function parseQuery(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, value as string]),
    );
  } catch {
    return {};
  }
}

export async function emailDocumentAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await requireUser();
    const parsed = emailSchema.safeParse(formObject(formData));
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors as Record<string, string[]>;
      return fail("Please correct the highlighted fields.", flat);
    }
    const input = parsed.data;

    let document: EmailableDocument;
    if (input.docKind === "welcome-kit") {
      if (!input.applicationId) return fail("No application to send.");
      document = { kind: "welcome-kit", applicationId: input.applicationId };
    } else if (input.docKind === "receipt") {
      if (!input.receiptId) return fail("No receipt to send.");
      document = { kind: "receipt", receiptId: input.receiptId };
    } else {
      if (!input.reportKey) return fail("No report to send.");
      document = {
        kind: "report",
        reportKey: input.reportKey,
        query: parseQuery(input.reportQuery),
        format: input.format ?? "pdf",
      };
    }

    // Building it first means a document that cannot be produced is reported as
    // such, rather than sending an email with nothing useful attached.
    const prepared = await prepareDocument(document, user.permissions);

    const result = await deliverEmail({
      kind: prepared.logKind,
      to: input.to,
      subject: input.subject,
      body: input.message,
      attachments: [prepared.attachment],
      studentId: prepared.studentId,
      applicationId: prepared.applicationId,
    });

    await recordAudit({
      userId: user.id,
      action: "document.emailed",
      entityType: prepared.studentId ? "Student" : "Document",
      entityId: prepared.studentId ?? prepared.applicationId,
      summary: `${prepared.attachment.filename} emailed to ${input.to}${result.ok ? "" : " — delivery failed"}`,
      metadata: { docKind: input.docKind, to: input.to, file: prepared.attachment.filename, ok: result.ok },
    });

    if (!result.ok) return fail(`Could not send: ${result.error}`);

    // In mock mode nothing actually leaves the building; saying "sent" would be
    // a lie the office only discovers when the family says they got nothing.
    const config = await getCommunicationConfig();
    return emailIsLive(config)
      ? ok(undefined, `Sent to ${input.to} with ${prepared.attachment.filename} attached.`)
      : ok(
          undefined,
          `Logged only — the email provider is set to Mock, so nothing was delivered. ` +
            `Configure Gmail or SMTP in Setup → Communication to send for real.`,
        );
  });
}
