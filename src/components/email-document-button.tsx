"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError } from "@/components/form";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { emailDocumentAction } from "@/app/(app)/email-actions";

/**
 * "Email" button for any generated document — welcome kit, fee receipt, report
 * or student ledger.
 *
 * Only identifiers are submitted. The server rebuilds the document and attaches
 * it, so the recipient gets exactly what the office would have printed, and the
 * browser is never trusted with the file.
 */
export type EmailDocumentTarget =
  | { kind: "welcome-kit"; applicationId: string }
  | { kind: "receipt"; receiptId: string }
  | { kind: "report"; reportKey: string; query: Record<string, string> };

export function EmailDocumentButton({
  target,
  defaultTo,
  defaultSubject,
  defaultMessage,
  label = "Email",
  variant = "secondary",
  size = "md",
  /** Reports can be attached as PDF, Excel or CSV; the rest are always PDF. */
  allowFormatChoice = false,
}: {
  target: EmailDocumentTarget;
  defaultTo?: string | null;
  defaultSubject?: string;
  defaultMessage?: string;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  allowFormatChoice?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={defaultSubject ? "Send by email" : "Email this document"}
        description="The document is generated fresh and attached to the message."
      >
        <ActionForm
          action={emailDocumentAction}
          onSuccess={() => setOpen(false)}
        >
          {(state) => (
            <>
              <input type="hidden" name="docKind" value={target.kind} />
              {target.kind === "welcome-kit" ? (
                <input type="hidden" name="applicationId" value={target.applicationId} />
              ) : null}
              {target.kind === "receipt" ? <input type="hidden" name="receiptId" value={target.receiptId} /> : null}
              {target.kind === "report" ? (
                <>
                  <input type="hidden" name="reportKey" value={target.reportKey} />
                  {/* The live filters, so the attachment matches what is on
                      screen — column choice included. */}
                  <input type="hidden" name="reportQuery" value={JSON.stringify(target.query)} />
                </>
              ) : null}

              <Field label="To" htmlFor="email-to" required error={fieldError(state, "to")}>
                <Input
                  id="email-to"
                  name="to"
                  type="email"
                  defaultValue={defaultTo ?? ""}
                  required
                  placeholder="name@example.com"
                />
              </Field>

              {allowFormatChoice ? (
                <Field label="Attach as" htmlFor="email-format" error={fieldError(state, "format")}>
                  <Select id="email-format" name="format" defaultValue="pdf">
                    <option value="pdf">PDF</option>
                    <option value="xlsx">Excel</option>
                    <option value="csv">CSV</option>
                  </Select>
                </Field>
              ) : (
                <input type="hidden" name="format" value="pdf" />
              )}

              <Field label="Subject" htmlFor="email-subject" required error={fieldError(state, "subject")}>
                <Input id="email-subject" name="subject" defaultValue={defaultSubject ?? ""} required />
              </Field>

              <Field label="Message" htmlFor="email-message" required error={fieldError(state, "message")}>
                <Textarea id="email-message" name="message" rows={8} defaultValue={defaultMessage ?? ""} required />
              </Field>

              <Alert tone="info">
                The file is built when you press Send, so it reflects the data as it stands right now.
              </Alert>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Sending…">Send email</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
