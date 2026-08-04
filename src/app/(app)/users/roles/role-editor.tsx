"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Alert, Button, Checkbox, Field, FormGrid, Input, Textarea } from "@/components/ui";
import { PERMISSION_GROUPS } from "@/lib/permissions";
import { deleteRoleAction, saveRoleAction } from "../actions";

type RoleView = {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
};

function RoleFields({ role, state }: { role?: RoleView; state: FormState }) {
  const key = role?.id ?? "new";
  const granted = new Set(role?.permissions ?? []);
  return (
    <div className="space-y-5">
      {role ? <input type="hidden" name="id" value={role.id} /> : null}
      <FormGrid>
        <Field label="Role name" htmlFor={`name-${key}`} required error={fieldError(state, "name")}>
          <Input id={`name-${key}`} name="name" defaultValue={role?.name ?? ""} required readOnly={role?.isSystem} />
        </Field>
        <Field label="Description" htmlFor={`desc-${key}`} error={fieldError(state, "description")}>
          <Textarea id={`desc-${key}`} name="description" defaultValue={role?.description ?? ""} rows={2} />
        </Field>
      </FormGrid>

      <div>
        <p className="mb-2 text-sm font-medium">
          Permissions
          {fieldError(state, "permissions") ? (
            <span className="ml-2 text-xs font-normal text-danger">{fieldError(state, "permissions")}</span>
          ) : null}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {PERMISSION_GROUPS.map((group) => (
            <fieldset key={group.label} className="rounded-md border border-border p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">{group.label}</legend>
              <div className="space-y-1.5">
                {group.permissions.map((permission) => {
                  const inputId = `${key}-${permission.key}`;
                  return (
                    <div key={permission.key} className="flex items-start gap-2">
                      <Checkbox
                        id={inputId}
                        name="permissions"
                        value={permission.key}
                        defaultChecked={granted.has(permission.key)}
                        className="mt-0.5"
                      />
                      <label htmlFor={inputId} className="text-sm leading-snug">
                        {permission.label}
                      </label>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RoleEditor() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        New custom role
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="New custom role" width="lg">
        <ActionForm action={saveRoleAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <RoleFields state={state} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Creating…">Create role</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

export function RoleRowActions({ role }: { role: RoleView }) {
  const [editing, setEditing] = useState(false);
  const isAdmin = role.isSystem && role.name === "Admin";

  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={isAdmin}>
        Edit
      </Button>
      {!role.isSystem && role.userCount === 0 ? (
        <ActionForm action={deleteRoleAction} className="contents">
          <input type="hidden" name="id" value={role.id} />
          <SubmitButton variant="ghost" size="sm" className="text-danger" pendingLabel="Deleting…">
            Delete
          </SubmitButton>
        </ActionForm>
      ) : null}

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${role.name}`} width="lg">
        {role.isSystem ? (
          <Alert tone="info" title="Predefined role">
            The name is fixed, but you can adjust which permissions this role grants.
          </Alert>
        ) : null}
        <ActionForm action={saveRoleAction} onSuccess={() => setEditing(false)} className="mt-4">
          {(state) => (
            <>
              <RoleFields role={role} state={state} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Saving…">Save role</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </div>
  );
}
