"use client";

import { useState } from "react";
import { Button, Field, FormGrid, Select } from "@/components/ui";

type BatchOption = { id: string; name: string; semesters: { id: string; label: string }[] };

export function PromotionPicker({
  batches,
  selectedBatchId,
  selectedSemesterId,
}: {
  batches: BatchOption[];
  selectedBatchId: string;
  selectedSemesterId: string;
}) {
  const [batchId, setBatchId] = useState(selectedBatchId);
  const semesters = batches.find((b) => b.id === batchId)?.semesters ?? [];

  return (
    <form method="get" className="space-y-4">
      <FormGrid cols={3}>
        <Field label="Batch" htmlFor="batchId" required>
          <Select id="batchId" name="batchId" value={batchId} onChange={(e) => setBatchId(e.target.value)} required>
            <option value="">Select a batch…</option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Current semester" htmlFor="semesterId" required>
          <Select id="semesterId" name="semesterId" defaultValue={selectedSemesterId} required disabled={!batchId}>
            <option value="">Select…</option>
            {semesters.map((semester) => (
              <option key={semester.id} value={semester.id}>
                {semester.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit">Preview cohort</Button>
        </div>
      </FormGrid>
    </form>
  );
}
