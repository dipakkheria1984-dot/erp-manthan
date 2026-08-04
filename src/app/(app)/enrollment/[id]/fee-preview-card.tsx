import { Card, DescriptionList } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { scholarshipLabel } from "@/lib/enrollment";
import type { FeePreview } from "@/lib/enrollment";

export function FeePreviewCard({ preview, enrolled }: { preview: FeePreview; enrolled: boolean }) {
  return (
    <Card
      title={enrolled ? "Fee locked at enrollment" : "Fee preview"}
      description="Tuition is locked to the batch fee version effective on the enrollment date and stays there for every subsequent year. Exam and activity fees are never locked. The registration fee is part of this total — it is applied to the first installment, not deducted from the fee."
    >
      <DescriptionList
        items={[
          { label: "Batch preset tuition (current version)", value: formatPaise(preview.lockedRatePaise) },
          {
            label: "Scholarship",
            value: scholarshipLabel(preview.scholarshipPercent, preview.scholarshipAmountPaise),
          },
          { label: "Semester 1 exam fee", value: formatPaise(preview.examFeePaise) },
          { label: "Semester 1 activity fee", value: formatPaise(preview.activityFeePaise) },
          {
            label: "Total fee for semester 1",
            value: <span className="font-semibold">{formatPaise(preview.totalPayablePaise)}</span>,
          },
          {
            label: "Registration fee received (part of the total)",
            value: formatPaise(preview.registrationPaidPaise),
          },
          { label: "Still to be collected", value: formatPaise(preview.outstandingPaise) },
        ]}
      />
    </Card>
  );
}
