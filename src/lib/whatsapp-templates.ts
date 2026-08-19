import "server-only";
import type { NotificationKind } from "@/generated/prisma/client";

/**
 * WhatsApp template registry.
 *
 * ## Why templates exist at all
 *
 * Meta does not let a business send free-form WhatsApp text to someone who has
 * not messaged it in the last 24 hours. Everything this system sends is
 * business-initiated — a fee reminder, a welcome, an application update — so
 * every one of them has to go as a *template* that Meta has approved in
 * advance. That is a platform rule, not a quirk of any one gateway.
 *
 * The consequence is easy to miss: the message text this system composes is
 * for email. WhatsApp does not receive it. WhatsApp receives a template name
 * plus the variables that fill its blanks, and the wording the family reads was
 * fixed when the template was approved.
 *
 * ## What has to line up
 *
 * A template approved in the provider's panel has an ordered list of
 * placeholders — {{1}}, {{2}} and so on. `variables` below is that order, and
 * the sending code supplies exactly those values in exactly that sequence. Get
 * the order wrong and the family is told a due date where the amount should be,
 * with nothing to signal the mistake, so each entry names its variables so the
 * template can be written against them.
 */

export type WhatsAppTemplateSpec = {
  kind: NotificationKind;
  /** What this message is, on the setup screen. */
  label: string;
  /** Placeholders in the order the template must use them. */
  variables: string[];
  /** Shown under the field so the template can be drafted to match. */
  example: string;
};

export const WHATSAPP_TEMPLATES: WhatsAppTemplateSpec[] = [
  {
    kind: "FEE_PRE_DUE",
    label: "Fee due soon",
    variables: ["Student name", "Installment number", "Due date", "Total payable"],
    example: "Dear {{1}}, installment {{2}} is due on {{3}}. Total payable {{4}}.",
  },
  {
    kind: "FEE_OVERDUE",
    label: "Fee overdue",
    variables: ["Student name", "Installment number", "Due date", "Total payable"],
    example: "Dear {{1}}, installment {{2}} was due on {{3}} and is unpaid. Total payable {{4}}.",
  },
  {
    kind: "WELCOME",
    label: "Welcome / admission confirmed",
    variables: ["Student name", "Student ID", "Course", "Batch"],
    example: "Dear {{1}}, your admission is confirmed. Student ID {{2}}, course {{3}}, batch {{4}}.",
  },
  {
    kind: "APPLICATION_SUBMITTED",
    label: "Application received",
    variables: ["Applicant name", "Application ID"],
    example: "Dear {{1}}, we have received your admission application {{2}}.",
  },
  {
    kind: "APPLICATION_STATUS_CHANGE",
    label: "Application status changed",
    variables: ["Applicant name", "Application ID", "New status"],
    example: "Dear {{1}}, the status of application {{2}} is now {{3}}.",
  },
  {
    kind: "APPLICATION_INCOMPLETE",
    label: "Application incomplete",
    variables: ["Applicant name"],
    example: "Dear {{1}}, your admission application is still incomplete.",
  },
  {
    kind: "DOCUMENTS_PENDING",
    label: "Documents pending",
    variables: ["Applicant name", "Application ID"],
    example: "Dear {{1}}, some documents are still pending on application {{2}}.",
  },
  {
    kind: "APPLICATION_LINK",
    label: "Online admission form link",
    variables: ["Applicant name", "Form link"],
    example: "Dear {{1}}, here is your admission form: {{2}}",
  },
];

export function templateSpec(kind: NotificationKind): WhatsAppTemplateSpec | null {
  return WHATSAPP_TEMPLATES.find((entry) => entry.kind === kind) ?? null;
}

/**
 * The `whatsappExtra` shape: which approved template answers which message, and
 * the language they were approved in.
 *
 * Held as JSON rather than columns because template names are per-account
 * strings the institute chooses in its own panel, and a new message kind should
 * not need a migration to become sendable.
 */
export type WhatsAppTemplateSettings = {
  /** NotificationKind -> the template name approved in the provider's panel. */
  names: Partial<Record<NotificationKind, string>>;
  /** Language code the templates were approved under, e.g. "en" or "en_US". */
  language: string;
};

export const DEFAULT_TEMPLATE_LANGUAGE = "en";

/** Reads the settings back out of the config's free-form JSON, defensively. */
export function templateSettings(extra: unknown): WhatsAppTemplateSettings {
  const source = (extra ?? {}) as { names?: unknown; language?: unknown };
  const names: Partial<Record<NotificationKind, string>> = {};

  if (source.names && typeof source.names === "object") {
    for (const spec of WHATSAPP_TEMPLATES) {
      const value = (source.names as Record<string, unknown>)[spec.kind];
      if (typeof value === "string" && value.trim()) names[spec.kind] = value.trim();
    }
  }

  const language = typeof source.language === "string" && source.language.trim()
    ? source.language.trim()
    : DEFAULT_TEMPLATE_LANGUAGE;

  return { names, language };
}
