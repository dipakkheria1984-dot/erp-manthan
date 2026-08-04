"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError } from "@/components/form";
import { Button, Field, Input, Textarea } from "@/components/ui";
import { waiveLateFeeAction } from "@/app/(app)/students/actions";

/**
 * Write off an accrued late fee, in full or in part.
 *
 * Lives on the collection screen as well as the student record, because this is
 * a counter decision: the Accountant sees what the late fee comes to as they
 * are about to issue the receipt, and settles it there and then. Leaving the
 * amount blank waives the whole of it.
 *
 * A fee already collected can be waived too. The receipt stands and no cash goes
 * back over the counter — the amount is credited against what the family owes
 * next, so their next payment is smaller by exactly that much.
 */
export function WaiveLateFeeButton({
  installmentId,
  outstandingLateFeeLabel,
  collectedLateFeeLabel,
  label = "Waive late fee",
}: {
  installmentId: string;
  /** The whole waivable figure — what is owed plus anything collected. */
  outstandingLateFeeLabel: string;
  /** Set when part of it has already been paid, which changes what happens. */
  collectedLateFeeLabel?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Waive late fee — ${outstandingLateFeeLabel}`}
        description={
          collectedLateFeeLabel
            ? `${collectedLateFeeLabel} of this has already been collected. That receipt is not touched and no cash is refunded — the amount is credited against the student's next unpaid installments, so the next payment is smaller by exactly that much. Only the late fee is affected; the installment principal is unchanged.`
            : "Only the late fee is written off; the installment principal is unchanged. Waiving the whole of it also stops any further late fee accruing on this installment."
        }
      >
        <ActionForm action={waiveLateFeeAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <input type="hidden" name="installmentId" value={installmentId} />

              <Field
                label="Amount to waive (₹)"
                htmlFor="lateFeeWaiveAmount"
                hint={`Leave blank to waive the whole ${outstandingLateFeeLabel}. Enter less to waive part of it${
                  collectedLateFeeLabel ? " — what is still owed is written off before anything is credited back" : ""
                }.`}
                error={fieldError(state, "amount")}
              >
                <Input id="lateFeeWaiveAmount" name="amount" inputMode="decimal" placeholder={outstandingLateFeeLabel} />
              </Field>

              <Field
                label="Why is it being waived?"
                htmlFor="lateFeeWaiveReason"
                required
                hint="Written to the audit trail."
                error={fieldError(state, "reason")}
              >
                <Textarea
                  id="lateFeeWaiveReason"
                  name="reason"
                  rows={3}
                  required
                  minLength={5}
                  placeholder="e.g. Cheque was deposited on time but cleared late through no fault of the family."
                />
              </Field>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Waiving…">Waive late fee</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
