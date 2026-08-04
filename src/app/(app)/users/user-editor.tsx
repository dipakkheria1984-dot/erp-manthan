"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Alert, Button, Field, FormGrid, Input, Select } from "@/components/ui";
import { resetUserPasswordAction, saveUserAction, unlockUserAction } from "./actions";

type Option = { id: string; name: string };
type UserView = {
  id: string;
  name: string;
  employeeId: string;
  email: string;
  phone: string | null;
  roleId: string;
  departmentId: string | null;
  status: "ACTIVE" | "INACTIVE";
};

function UserFields({
  user,
  roles,
  departments,
  state,
}: {
  user?: UserView;
  roles: Option[];
  departments: Option[];
  state: FormState;
}) {
  const key = user?.id ?? "new";
  return (
    <FormGrid>
      {user ? <input type="hidden" name="id" value={user.id} /> : null}
      <Field label="Full name" htmlFor={`name-${key}`} required error={fieldError(state, "name")}>
        <Input id={`name-${key}`} name="name" defaultValue={user?.name ?? ""} required />
      </Field>
      <Field label="Employee ID" htmlFor={`emp-${key}`} required error={fieldError(state, "employeeId")}>
        <Input id={`emp-${key}`} name="employeeId" defaultValue={user?.employeeId ?? ""} required />
      </Field>
      <Field label="Email" htmlFor={`email-${key}`} required error={fieldError(state, "email")}>
        <Input id={`email-${key}`} name="email" type="email" defaultValue={user?.email ?? ""} required />
      </Field>
      <Field label="Phone" htmlFor={`phone-${key}`} error={fieldError(state, "phone")}>
        <Input id={`phone-${key}`} name="phone" defaultValue={user?.phone ?? ""} />
      </Field>
      <Field label="Role" htmlFor={`role-${key}`} required error={fieldError(state, "roleId")}>
        <Select id={`role-${key}`} name="roleId" defaultValue={user?.roleId ?? ""} required>
          <option value="">Select a role…</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Department"
        htmlFor={`dept-${key}`}
        hint="Optional — scopes the account to one department."
        error={fieldError(state, "departmentId")}
      >
        <Select id={`dept-${key}`} name="departmentId" defaultValue={user?.departmentId ?? ""}>
          <option value="">All departments</option>
          {departments.map((dept) => (
            <option key={dept.id} value={dept.id}>
              {dept.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Status" htmlFor={`status-${key}`} required error={fieldError(state, "status")}>
        <Select id={`status-${key}`} name="status" defaultValue={user?.status ?? "ACTIVE"}>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </Select>
      </Field>
    </FormGrid>
  );
}

export function UserEditor({ roles, departments }: { roles: Option[]; departments: Option[] }) {
  const [open, setOpen] = useState(false);
  const [credential, setCredential] = useState<string | null>(null);

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        New staff account
      </Button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setCredential(null);
        }}
        title="New staff account"
        description="A temporary password is generated and shown once."
      >
        {credential ? (
          <div className="space-y-4">
            <Alert tone="success" title="Account created">
              Share this temporary password securely. It will not be shown again — the user must change it at first
              sign-in.
            </Alert>
            <p className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">{credential}</p>
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setCredential(null);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <ActionForm
            action={saveUserAction}
            onSuccess={(state) => {
              const data = state.ok ? (state.data as { temporaryPassword?: string }) : undefined;
              setCredential(data?.temporaryPassword ?? "(password unchanged)");
            }}
          >
            {(state) => (
              <>
                <UserFields roles={roles} departments={departments} state={state} />
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <SubmitButton pendingLabel="Creating…">Create account</SubmitButton>
                </div>
              </>
            )}
          </ActionForm>
        )}
      </Modal>
    </>
  );
}

export function UserRowActions({
  user,
  locked,
  roles,
  departments,
}: {
  user: UserView;
  locked: boolean;
  roles: Option[];
  departments: Option[];
}) {
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [credential, setCredential] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setResetting(true)}>
        Reset password
      </Button>
      {locked ? (
        <ActionForm action={unlockUserAction} className="contents">
          <input type="hidden" name="id" value={user.id} />
          <SubmitButton variant="ghost" size="sm" pendingLabel="…">
            Unlock
          </SubmitButton>
        </ActionForm>
      ) : null}

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${user.name}`}>
        <ActionForm action={saveUserAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <UserFields user={user} roles={roles} departments={departments} state={state} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>

      <Modal
        open={resetting}
        onClose={() => {
          setResetting(false);
          setCredential(null);
        }}
        title={`Reset password for ${user.name}`}
        description="The current password stops working immediately and every active session is signed out."
      >
        {credential ? (
          <div className="space-y-4">
            <Alert tone="success" title="Temporary password generated">
              Share it securely — it is shown once.
            </Alert>
            <p className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">{credential}</p>
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => {
                  setResetting(false);
                  setCredential(null);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <ActionForm
            action={resetUserPasswordAction}
            onSuccess={(state) => {
              const data = state.ok ? (state.data as { temporaryPassword: string }) : undefined;
              setCredential(data?.temporaryPassword ?? null);
            }}
          >
            <input type="hidden" name="id" value={user.id} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setResetting(false)}>
                Cancel
              </Button>
              <SubmitButton variant="danger" pendingLabel="Resetting…">
                Reset password
              </SubmitButton>
            </div>
          </ActionForm>
        )}
      </Modal>
    </div>
  );
}
