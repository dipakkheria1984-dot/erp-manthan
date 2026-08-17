"use client";

import { ActionForm, SubmitButton } from "@/components/form";
import { Input } from "@/components/ui";
import { uploadPortalDocumentAction } from "../../actions";

export function PortalDocumentUpload({
  token,
  requirementCode,
  hasFile,
}: {
  token: string;
  requirementCode: string;
  hasFile: boolean;
}) {
  return (
    <ActionForm action={uploadPortalDocumentAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="requirementCode" value={requirementCode} />
      <Input
        type="file"
        name="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        required
        className="w-56 py-1 text-xs"
      />
      <SubmitButton size="sm" variant="secondary" pendingLabel="Uploading…">
        {hasFile ? "Replace" : "Upload"}
      </SubmitButton>
    </ActionForm>
  );
}
