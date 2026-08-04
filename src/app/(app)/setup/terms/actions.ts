"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { recordAuditTx } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { termsDocumentLabel } from "@/lib/terms";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { dateInput, fieldErrorsOf, formObject, requiredText } from "@/lib/validation";

const termsSchema = z.object({
  document: z.enum(["ADMISSION", "RECEIPT"]),
  title: requiredText("Title", 2),
  content: requiredText("Content", 10),
  effectiveFrom: dateInput("Effective from"),
});

/**
 * Save a new T&C version (spec 10.1).
 *
 * Editing never overwrites: every save creates a new version and the previous
 * ones are retained for legal and audit purposes. Receipts print whichever
 * version was in force on the payment date, so old receipts stay faithful.
 *
 * Admission terms and receipt terms are separate documents on separate version
 * sequences, so saving one leaves the other untouched.
 */
export async function saveTermsVersionAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.TERMS_MANAGE);
    const parsed = termsSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { document, title, content, effectiveFrom } = parsed.data;
    const documentLabel = termsDocumentLabel(document);

    const clash = await prisma.termsVersion.findFirst({ where: { document, effectiveFrom } });
    if (clash) {
      return fail(
        `${documentLabel} terms version ${clash.version} already takes effect on that date. Choose a different date.`,
        { effectiveFrom: ["A version already starts on this date."] },
      );
    }

    const version = await prisma.$transaction(async (tx) => {
      const latest = await tx.termsVersion.findFirst({ where: { document }, orderBy: { version: "desc" } });
      const nextVersion = (latest?.version ?? 0) + 1;

      const created = await tx.termsVersion.create({
        data: { document, version: nextVersion, title, content, effectiveFrom, createdById: actor.id },
      });

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "terms.version_created",
        entityType: "TermsVersion",
        entityId: String(created.id),
        summary: `${documentLabel} terms & conditions version ${nextVersion} created, effective ${effectiveFrom.toDateString()}`,
        metadata: { document, version: nextVersion, effectiveFrom },
      });

      return nextVersion;
    });

    revalidatePath("/setup/terms");
    return ok(undefined, `${documentLabel} terms version ${version} saved. Earlier versions are retained.`);
  });
}
