"use client";

import { ReasonActionButton } from "@/components/form";
import { cancelReceiptAction } from "../actions";

export function CancelReceiptButton({ paymentId, receiptNo }: { paymentId: string; receiptNo: string }) {
  return (
    <ReasonActionButton
      action={cancelReceiptAction}
      label="Cancel"
      title={`Cancel receipt ${receiptNo}`}
      description="The receipt is voided, never deleted, and its number is not reused. The installment status and late fee are recalculated against the original due date."
      confirmLabel="Void receipt"
      reasonLabel="Cancellation reason"
      reasonPlaceholder="e.g. Posted against the wrong student; re-entered as RCP00042."
      variant="danger"
      size="sm"
      hidden={{ paymentId }}
    />
  );
}
