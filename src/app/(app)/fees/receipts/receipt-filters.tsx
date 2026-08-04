"use client";

import { Button, Field, FormGrid, Input, Select } from "@/components/ui";

export function ReceiptFilters({
  defaults,
}: {
  defaults: { q: string; status: string; from: string; to: string };
}) {
  return (
    <form method="get" className="space-y-4">
      <FormGrid cols={4}>
        <Field label="Search" htmlFor="q" hint="Receipt no., reference, student ID or name">
          <Input id="q" name="q" defaultValue={defaults.q} />
        </Field>
        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue={defaults.status}>
            <option value="">All</option>
            <option value="ACTIVE">Active only</option>
            <option value="CANCELLED">Cancelled only</option>
          </Select>
        </Field>
        <Field label="From" htmlFor="from">
          <Input id="from" name="from" type="date" defaultValue={defaults.from} />
        </Field>
        <Field label="To" htmlFor="to">
          <Input id="to" name="to" type="date" defaultValue={defaults.to} />
        </Field>
      </FormGrid>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Apply filters
        </Button>
        <Button type="submit" size="sm" variant="secondary" formAction="/fees/receipts">
          Reset
        </Button>
      </div>
    </form>
  );
}
