"use client";

import { Button, Field, Input } from "@/components/ui";

export function StudentSearch({ defaultQuery }: { defaultQuery: string }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <Field label="Student ID, name or phone" htmlFor="q" className="min-w-64 flex-1">
        <Input id="q" name="q" defaultValue={defaultQuery} placeholder="e.g. STU10001" autoFocus />
      </Field>
      <Button type="submit">Search</Button>
    </form>
  );
}
