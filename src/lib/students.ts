import type { BadgeTone } from "@/components/ui";

export const STUDENT_STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: "success",
  DROPPED_OUT: "warning",
  EXPELLED: "danger",
  PASSED: "info",
};

/** "DROPPED_OUT" → "Dropped-out" */
export function studentStatusLabel(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join("-");
}

export const INSTALLMENT_STATUS_TONE: Record<string, BadgeTone> = {
  PENDING: "neutral",
  PARTIALLY_PAID: "warning",
  PAID: "success",
  WAIVED: "info",
};

export function installmentStatusLabel(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

export const DISCOUNT_REASON_LABELS: Record<string, string> = {
  EARLY_PAYMENT: "Early payment",
  FINANCIAL_HARDSHIP: "Financial hardship",
  MERIT: "Merit",
  SIBLING: "Sibling concession",
  STAFF_WARD: "Staff ward",
  LATE_FEE_ADJUSTMENT: "Late fee refunded as credit",
  OTHER: "Other",
};

export function discountReasonLabel(reason: string): string {
  return DISCOUNT_REASON_LABELS[reason] ?? reason.replaceAll("_", " ").toLowerCase();
}

/** What an ad-hoc charge raised after enrollment is for. */
export const EXTRA_CHARGE_KIND_LABELS: Record<string, string> = {
  ACTIVITY: "Activity",
  EVENT: "Event",
  PENALTY: "Penalty",
  OTHER: "Extra charge",
};

export function extraChargeKindLabel(kind: string | null | undefined): string {
  if (!kind) return "Extra charge";
  return EXTRA_CHARGE_KIND_LABELS[kind] ?? kind.charAt(0) + kind.slice(1).toLowerCase();
}
