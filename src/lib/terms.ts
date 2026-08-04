import "server-only";
import { prisma, type Db } from "@/lib/db";
import { endOfDay } from "@/lib/dates";
import type { TermsDocument } from "@/generated/prisma/client";

/**
 * Terms & conditions (spec 10.1 / 10.2).
 *
 * The admission form and the fee receipt carry different terms, so every lookup
 * names the document it is printing. Each document has its own version
 * sequence — admission v3 and receipt v3 are unrelated.
 */

export const TERMS_DOCUMENTS: {
  key: TermsDocument;
  label: string;
  /** Where this set of terms is printed, shown on the setup screen. */
  printedOn: string;
}[] = [
  {
    key: "ADMISSION",
    label: "Admission form",
    printedOn: "Printed on the admission form and on the welcome kit's terms page.",
  },
  {
    key: "RECEIPT",
    label: "Fee receipt",
    printedOn: "Printed at the foot of both copies of every fee receipt.",
  },
];

export function termsDocumentLabel(document: TermsDocument): string {
  return TERMS_DOCUMENTS.find((entry) => entry.key === document)?.label ?? document;
}

/**
 * The version of `document` in force on a given date. Receipts print the version
 * effective when the payment was taken, so a reprint of an old receipt still
 * shows the terms that applied at the time.
 *
 * The comparison runs against the end of that day: a version made effective
 * "today" carries a timestamp, and a receipt dated today sits at local midnight,
 * so a naive `<=` would miss it. If nothing is in force yet — a receipt
 * predating the first version — the earliest version is used rather than
 * printing a receipt with no terms at all.
 */
export async function termsInForce(document: TermsDocument, asOf: Date = new Date(), db: Db = prisma) {
  const current = await db.termsVersion.findFirst({
    where: { document, effectiveFrom: { lte: endOfDay(asOf) } },
    orderBy: { effectiveFrom: "desc" },
  });
  if (current) return current;

  return db.termsVersion.findFirst({ where: { document }, orderBy: { effectiveFrom: "asc" } });
}
