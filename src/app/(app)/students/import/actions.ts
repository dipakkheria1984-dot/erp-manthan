"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { storeSpreadsheet, deleteUpload } from "@/lib/storage";
import { commitImport, prepareImport, type ImportPreview } from "@/lib/student-import";

/**
 * Step 1 — parse and validate the uploaded file without writing anything.
 *
 * The file is kept on disk and re-read at commit time, so the Admin approves
 * exactly the rows that get written; nothing is carried through the browser.
 */
export async function previewImportAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<ImportPreview>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.STUDENT_IMPORT);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return fail("Choose a .csv or .xlsx file to import.", { file: ["No file selected."] });
    }

    const stored = await storeSpreadsheet(file, "imports");
    const preview = await prepareImport(stored.storagePath, stored.fileName);

    await recordAudit({
      userId: actor.id,
      action: "student.import_previewed",
      summary: `Bulk import preview of ${stored.fileName} — ${preview.validRows}/${preview.totalRows} row(s) valid`,
      metadata: { storagePath: stored.storagePath, fatal: preview.fatal },
    });

    if (preview.fatal.length > 0) {
      // Nothing usable in the file — don't leave it lying around.
      await deleteUpload(stored.storagePath);
      return fail(preview.fatal.join(" "));
    }

    return ok(preview, `${preview.validRows} of ${preview.totalRows} row(s) are ready to import.`);
  });
}

/** Step 2 — write the valid rows. */
export async function commitImportAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<{ created: number; skipped: number }>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.STUDENT_IMPORT);
    const storagePath = String(formData.get("storagePath") ?? "");
    const fileName = String(formData.get("fileName") ?? "import");
    if (!storagePath) return fail("The uploaded file is no longer available. Upload it again.");

    // Re-validate rather than trusting anything round-tripped through the form:
    // the database may have changed between preview and confirmation.
    const preview = await prepareImport(storagePath, fileName);
    if (preview.fatal.length > 0) return fail(preview.fatal.join(" "));
    if (preview.validRows === 0) return fail("There are no valid rows left to import.");

    const outcome = await commitImport(preview, actor.id);

    await recordAudit({
      userId: actor.id,
      action: "student.imported",
      summary: `Bulk import of ${fileName} — ${outcome.created} student(s) created, ${outcome.skipped} row(s) skipped`,
      metadata: { studentCodes: outcome.studentCodes, storagePath },
    });

    revalidatePath("/students");
    revalidatePath("/reports");
    return ok(
      { created: outcome.created, skipped: outcome.skipped },
      `Imported ${outcome.created} student(s).${outcome.skipped > 0 ? ` ${outcome.skipped} row(s) with errors were skipped.` : ""}`,
    );
  });
}
