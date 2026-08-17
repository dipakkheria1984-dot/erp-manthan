"use client";

import { Button, Field, FormGrid, Input, Select } from "@/components/ui";

const STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "ENROLLED"];

export function ApplicationFilters({
  batches,
  defaults,
}: {
  batches: { id: string; name: string }[];
  defaults: { q: string; status: string; batchId: string; from: string; to: string; queue: string };
}) {
  return (
    <form method="get" className="space-y-4">
      <FormGrid cols={4}>
        <Field label="Search" htmlFor="q" hint="Name, application ID, student ID or phone">
          <Input id="q" name="q" defaultValue={defaults.q} placeholder="e.g. APP00001" />
        </Field>
        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue={defaults.status}>
            <option value="">All statuses</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status
                  .split("_")
                  .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
                  .join(" ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Queue"
          htmlFor="queue"
          hint="Online forms the applicant has finished and nobody has picked up."
        >
          <Select id="queue" name="queue" defaultValue={defaults.queue}>
            <option value="">Everything</option>
            <option value="awaiting-fee">Awaiting fee assignment</option>
            <option value="online">All online applications</option>
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
        <div className="grid grid-cols-2 gap-2">
          <Field label="From" htmlFor="from">
            <Input id="from" name="from" type="date" defaultValue={defaults.from} />
          </Field>
          <Field label="To" htmlFor="to">
            <Input id="to" name="to" type="date" defaultValue={defaults.to} />
          </Field>
        </div>
      </FormGrid>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Apply filters
        </Button>
        <Button type="submit" size="sm" variant="secondary" formAction="/enrollment">
          Reset
        </Button>
      </div>
    </form>
  );
}
