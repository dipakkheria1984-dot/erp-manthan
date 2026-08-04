"use client";

import { Button, Field, FormGrid, Input, Select } from "@/components/ui";

export function AuditFilters({
  users,
  defaults,
}: {
  users: { id: string; name: string }[];
  defaults: { userId: string; action: string; from: string; to: string };
}) {
  return (
    <form method="get" className="space-y-4">
      <FormGrid cols={4}>
        <Field label="User" htmlFor="userId">
          <Select id="userId" name="userId" defaultValue={defaults.userId}>
            <option value="">All users</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Action contains" htmlFor="action">
          <Input id="action" name="action" defaultValue={defaults.action} placeholder="e.g. approve" />
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
        <Button type="submit" size="sm" variant="secondary" formAction="/users/audit">
          Reset
        </Button>
      </div>
    </form>
  );
}
