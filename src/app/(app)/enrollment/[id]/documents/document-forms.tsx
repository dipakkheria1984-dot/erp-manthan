"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError } from "@/components/form";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { uploadDocumentAction, verifyDocumentAction } from "../../actions";

export function DocumentUpload({
  applicationId,
  requirementCode,
  hasFile,
}: {
  applicationId: string;
  requirementCode: string;
  hasFile: boolean;
}) {
  return (
    <ActionForm action={uploadDocumentAction} className="flex items-center gap-2">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="requirementCode" value={requirementCode} />
      <Input
        type="file"
        name="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        required
        className="w-48 py-1 text-xs"
      />
      <SubmitButton size="sm" variant="secondary" pendingLabel="Uploading…">
        {hasFile ? "Replace" : "Upload"}
      </SubmitButton>
    </ActionForm>
  );
}

export function DocumentVerification({ documentId }: { documentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Verify
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Verify document">
        <ActionForm action={verifyDocumentAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <input type="hidden" name="documentId" value={documentId} />
              <Field label="Decision" htmlFor="decision" required error={fieldError(state, "decision")}>
                <Select id="decision" name="decision" defaultValue="VERIFIED">
                  <option value="VERIFIED">Verified</option>
                  <option value="REJECTED">Rejected</option>
                </Select>
              </Field>
              <Field
                label="Remarks"
                htmlFor="remarks"
                hint="Required when rejecting — the applicant is told what to fix."
                error={fieldError(state, "remarks")}
              >
                <Textarea id="remarks" name="remarks" rows={3} />
              </Field>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Saving…">Save decision</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
