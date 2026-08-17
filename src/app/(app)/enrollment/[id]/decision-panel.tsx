"use client";

import { useState } from "react";
import { ActionForm, ReasonActionButton, SubmitButton, fieldError } from "@/components/form";
import { Alert, Field, FormGrid, Input, Select } from "@/components/ui";
import {
  approveApplicationAction,
  discardApplicationAction,
  rejectApplicationAction,
  startReviewAction,
  submitApplicationAction,
  toggleProvisionalAction,
} from "../actions";

/**
 * Only ever shown on a draft. Everything past that point is rejected rather
 * than deleted — there is an application number in the applicant's hands by
 * then, and a reason on the record is worth more than a tidy list.
 */
export function DiscardDraftButton({ applicationId }: { applicationId: string }) {
  return (
    <ReasonActionButton
      action={discardApplicationAction}
      label="Discard draft"
      title="Discard this draft application"
      description="The draft and everything entered on it — guardians, uploaded documents, the fee plan — are deleted for good. This cannot be undone. The reason you give is kept on the audit trail."
      confirmLabel="Discard permanently"
      reasonLabel="Why is this being discarded?"
      reasonPlaceholder="e.g. duplicate of APP00042, or started in error"
      variant="danger"
      hidden={{ applicationId }}
    />
  );
}

export function SubmitApplicationButton({ applicationId, disabled }: { applicationId: string; disabled: boolean }) {
  return (
    <ActionForm action={submitApplicationAction}>
      <input type="hidden" name="applicationId" value={applicationId} />
      <SubmitButton disabled={disabled} pendingLabel="Submitting…">
        Submit application
      </SubmitButton>
    </ActionForm>
  );
}

export function StartReviewButton({ applicationId }: { applicationId: string }) {
  return (
    <ActionForm action={startReviewAction} className="contents">
      <input type="hidden" name="applicationId" value={applicationId} />
      <SubmitButton variant="secondary" pendingLabel="Updating…">
        Move to Under Review
      </SubmitButton>
    </ActionForm>
  );
}

export function ProvisionalToggle({ applicationId, isProvisional }: { applicationId: string; isProvisional: boolean }) {
  return (
    <ReasonActionButton
      action={toggleProvisionalAction}
      label={isProvisional ? "Withdraw provisional admission" : "Grant provisional admission"}
      title={isProvisional ? "Withdraw provisional admission" : "Grant provisional admission"}
      description="Provisional admission lets a student start before the registration fee is fully collected. It clears itself the moment that money is received — no one has to come back and confirm it."
      confirmLabel={isProvisional ? "Withdraw" : "Grant"}
      variant="secondary"
      hidden={{ applicationId }}
    />
  );
}

export function RejectButton({ applicationId }: { applicationId: string }) {
  return (
    <ReasonActionButton
      action={rejectApplicationAction}
      label="Reject application"
      title="Reject application"
      description="The reason is logged in the audit trail and sent to the applicant."
      confirmLabel="Reject"
      reasonLabel="Rejection reason"
      reasonPlaceholder="e.g. Documents could not be verified after two follow-ups."
      variant="danger"
      hidden={{ applicationId }}
    />
  );
}

export function ApprovalPanel({
  applicationId,
  requestedScholarshipPercent,
  requestedScholarshipPaise,
  requestedLabel,
  planSummary,
  seatsLeft,
  nextLfNo,
  studentIdPrefix,
  lfNoLength,
}: {
  applicationId: string;
  requestedScholarshipPercent: number;
  requestedScholarshipPaise: number;
  /** How the concession was asked for, e.g. "12%" or "₹15,000.00". */
  requestedLabel: string;
  /** e.g. "4 installments totalling ₹80,000.00, first due 01/08/2026". */
  planSummary: string | null;
  seatsLeft: number;
  nextLfNo: number;
  studentIdPrefix: string;
  lfNoLength: number;
}) {
  const [lfNo, setLfNo] = useState("");
  const [basis, setBasis] = useState<"PERCENT" | "AMOUNT">(requestedScholarshipPaise > 0 ? "AMOUNT" : "PERCENT");
  const effectiveLf = lfNo.trim() === "" ? nextLfNo : Number.parseInt(lfNo, 10);
  const preview = Number.isFinite(effectiveLf)
    ? `${studentIdPrefix}${String(effectiveLf).padStart(lfNoLength, "0")}`
    : "—";

  return (
    <ActionForm action={approveApplicationAction}>
      {(state) => (
        <>
          <input type="hidden" name="applicationId" value={applicationId} />
          <h3 className="text-sm font-semibold">Approve and enrol</h3>
          {seatsLeft <= 0 ? (
            <Alert tone="danger" title="No seats left">
              This batch is at capacity, so approval is blocked. There is no waitlist.
            </Alert>
          ) : null}
          {planSummary ? (
            <p className="text-sm text-muted">
              The Registrar&apos;s fee plan — {planSummary} — becomes the student&apos;s schedule on approval. Changing
              the scholarship below changes the total fee, so the plan must be updated on step 5 to match.
            </p>
          ) : (
            <Alert tone="danger" title="No fee plan entered">
              The installment plan has to be entered on step 5 before this application can be approved.
            </Alert>
          )}

          <FormGrid cols={3}>
            <Field
              label="LF No."
              htmlFor="lfNo"
              hint={`Leave blank to use the next number (${nextLfNo}).`}
              error={fieldError(state, "lfNo")}
            >
              <Input
                id="lfNo"
                name="lfNo"
                inputMode="numeric"
                value={lfNo}
                onChange={(e) => setLfNo(e.target.value)}
                placeholder={String(nextLfNo)}
              />
            </Field>
            <Field label="Student ID preview" htmlFor="studentIdPreview">
              <Input id="studentIdPreview" value={preview} readOnly disabled />
            </Field>
            <Field label="Scholarship given as" htmlFor="scholarshipBasis">
              <Select
                id="scholarshipBasis"
                name="scholarshipBasis"
                value={basis}
                onChange={(e) => setBasis(e.target.value as "PERCENT" | "AMOUNT")}
              >
                <option value="PERCENT">A percentage of the batch fee</option>
                <option value="AMOUNT">A fixed amount</option>
              </Select>
            </Field>
            {basis === "PERCENT" ? (
              <Field
                label="Approved scholarship (%)"
                htmlFor="approvedScholarshipPercent"
                hint={`${requestedLabel} was requested. Year 1 only. 0 — or blank — approves no scholarship.`}
                error={fieldError(state, "approvedScholarshipPercent")}
              >
                <Input
                  id="approvedScholarshipPercent"
                  name="approvedScholarshipPercent"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={requestedScholarshipPercent}
                />
              </Field>
            ) : (
              <Field
                label="Approved scholarship (₹)"
                htmlFor="approvedScholarshipAmount"
                hint={`${requestedLabel} was requested. Year 1 only; cannot exceed the batch fee. Blank approves no scholarship.`}
                error={fieldError(state, "approvedScholarshipAmount")}
              >
                <Input
                  id="approvedScholarshipAmount"
                  name="approvedScholarshipAmount"
                  inputMode="decimal"
                  defaultValue={requestedScholarshipPaise > 0 ? requestedScholarshipPaise / 100 : ""}
                />
              </Field>
            )}
          </FormGrid>

          <Field label="Approval reason / remark" htmlFor="approveReason" required error={fieldError(state, "reason")}>
            <Input
              id="approveReason"
              name="reason"
              required
              minLength={5}
              placeholder="e.g. All documents verified; scholarship approved per committee note 12/26."
            />
          </Field>

          <div className="pt-2">
            <SubmitButton disabled={seatsLeft <= 0 || !planSummary} pendingLabel="Approving…">
              Approve and enrol
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
