"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { storeSpreadsheet, deleteUpload } from "@/lib/storage";
import {
  commitAcademicImport,
  prepareAcademicImport,
  type AcademicOutcome,
  type AcademicPreview,
} from "@/lib/imports/academic";

/** Step 1 — parse and validate the workbook without writing anything. */
export async function previewAcademicImportAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<AcademicPreview>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return fail("Choose the .xlsx workbook to import.", { file: ["No file selected."] });
    }

    const stored = await storeSpreadsheet(file, "imports");
    const preview = await prepareAcademicImport(stored.storagePath, stored.fileName);

    await recordAudit({
      userId: actor.id,
      action: "academic.import_previewed",
      summary: `Academic import preview of ${stored.fileName} — ${preview.validRows}/${preview.totalRows} row(s) valid`,
      metadata: { storagePath: stored.storagePath, counts: preview.counts, fatal: preview.fatal },
    });

    if (preview.fatal.length > 0) {
      await deleteUpload(stored.storagePath);
      return fail(preview.fatal.join(" "));
    }

    return ok(preview, `${preview.validRows} of ${preview.totalRows} row(s) are ready to import.`);
  });
}

/** Step 2 — create the departments, courses and batches. */
export async function commitAcademicImportAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<AcademicOutcome>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ACADEMIC_MANAGE);
    const storagePath = String(formData.get("storagePath") ?? "");
    const fileName = String(formData.get("fileName") ?? "import");
    if (!storagePath) return fail("The uploaded file is no longer available. Upload it again.");

    // Re-validate: codes may have been created by hand since the preview.
    const preview = await prepareAcademicImport(storagePath, fileName);
    if (preview.fatal.length > 0) return fail(preview.fatal.join(" "));
    if (preview.validRows === 0) return fail("There are no valid rows left to import.");

    const outcome = await commitAcademicImport(preview, actor.id);

    revalidatePath("/academic/departments");
    revalidatePath("/academic/courses");
    revalidatePath("/academic/batches");
    return ok(
      outcome,
      `Imported ${outcome.departments} department(s), ${outcome.courses} course(s) and ${outcome.batches} batch(es).`,
    );
  });
}
