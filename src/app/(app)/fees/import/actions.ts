"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { storeSpreadsheet, deleteUpload } from "@/lib/storage";
import { formatPaise } from "@/lib/money";
import {
  commitReceiptImport,
  prepareReceiptImport,
  type ReceiptOutcome,
  type ReceiptPreview,
} from "@/lib/imports/receipts";

/** Step 1 — work out what each row would settle, without writing anything. */
export async function previewReceiptImportAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<ReceiptPreview>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_COLLECT);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return fail("Choose a .csv or .xlsx file to import.", { file: ["No file selected."] });
    }

    const stored = await storeSpreadsheet(file, "imports");
    const preview = await prepareReceiptImport(stored.storagePath, stored.fileName);

    await recordAudit({
      userId: actor.id,
      action: "fee.receipt_import_previewed",
      summary: `Receipt import preview of ${stored.fileName} — ${preview.validRows}/${preview.totalRows} row(s) valid, ${formatPaise(preview.totalPaise)}`,
      metadata: { storagePath: stored.storagePath, totalPaise: preview.totalPaise, fatal: preview.fatal },
    });

    if (preview.fatal.length > 0) {
      await deleteUpload(stored.storagePath);
      return fail(preview.fatal.join(" "));
    }

    return ok(
      preview,
      `${preview.validRows} of ${preview.totalRows} row(s) are ready, totalling ${formatPaise(preview.totalPaise)}.`,
    );
  });
}

/** Step 2 — write the receipts. */
export async function commitReceiptImportAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<ReceiptOutcome>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_COLLECT);
    const storagePath = String(formData.get("storagePath") ?? "");
    const fileName = String(formData.get("fileName") ?? "import");
    if (!storagePath) return fail("The uploaded file is no longer available. Upload it again.");

    // Re-validate: a payment may have been recorded by hand since the preview,
    // which would change what each row can still settle.
    const preview = await prepareReceiptImport(storagePath, fileName);
    if (preview.fatal.length > 0) return fail(preview.fatal.join(" "));
    if (preview.validRows === 0) return fail("There are no valid rows left to import.");

    const outcome = await commitReceiptImport(preview, actor.id);

    revalidatePath("/fees/receipts");
    revalidatePath("/fees/collect");
    revalidatePath("/students");
    revalidatePath("/reports");
    return ok(
      outcome,
      `Imported ${outcome.created} receipt(s) totalling ${formatPaise(outcome.totalPaise)}.`,
    );
  });
}
