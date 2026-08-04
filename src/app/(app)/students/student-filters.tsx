"use client";

import { Button, Field, FormGrid, Input, Select } from "@/components/ui";

const STATUSES = ["ACTIVE", "DROPPED_OUT", "EXPELLED", "PASSED"];

export function StudentFilters({
  batches,
  defaults,
}: {
  batches: { id: string; name: string }[];
  defaults: { q: string; status: string; batchId: string };
}) {
  return (
    <form method="get" className="space-y-4">
      <FormGrid cols={3}>
        <Field label="Search" htmlFor="q" hint="Name, Student ID or phone">
          <Input id="q" name="q" defaultValue={defaults.q} />
        </Field>
        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue={defaults.status}>
            <option value="">Active and passed</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status
                  .split("_")
                  .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
                  .join("-")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Batch" htmlFor="batchId">
          <Select id="batchId" name="batchId" defaultValue={defaults.batchId}>
            <option value="">All batches</option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.name}
              </option>
            ))}
          </Select>
        </Field>
      </FormGrid>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Apply filters
        </Button>
        <Button type="submit" size="sm" variant="secondary" formAction="/students">
          Reset
        </Button>
      </div>
    </form>
  );
}
