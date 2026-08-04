"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Button, Field, FormGrid, Input, Select } from "@/components/ui";
import { deleteDepartmentAction, saveDepartmentAction } from "../actions";

type DepartmentView = {
  id: string;
  name: string;
  code: string;
  headOfDepartment: string | null;
  status: "ACTIVE" | "INACTIVE";
};

function DepartmentFields({ department, state }: { department?: DepartmentView; state: FormState }) {
  const key = department?.id ?? "new";
  return (
    <FormGrid>
      {department ? <input type="hidden" name="id" value={department.id} /> : null}
      <Field label="Name" htmlFor={`name-${key}`} required error={fieldError(state, "name")}>
        <Input id={`name-${key}`} name="name" defaultValue={department?.name ?? ""} required />
      </Field>
      <Field label="Code" htmlFor={`code-${key}`} required error={fieldError(state, "code")}>
        <Input id={`code-${key}`} name="code" defaultValue={department?.code ?? ""} required />
      </Field>
      <Field label="Head of department" htmlFor={`hod-${key}`} error={fieldError(state, "headOfDepartment")}>
        <Input id={`hod-${key}`} name="headOfDepartment" defaultValue={department?.headOfDepartment ?? ""} />
      </Field>
      <Field label="Status" htmlFor={`status-${key}`} required error={fieldError(state, "status")}>
        <Select id={`status-${key}`} name="status" defaultValue={department?.status ?? "ACTIVE"}>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </Select>
      </Field>
    </FormGrid>
  );
}

export function DepartmentEditor() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        New department
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="New department">
        <ActionForm action={saveDepartmentAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <DepartmentFields state={state} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Creating…">Create</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

export function DepartmentRowActions({
  department,
  canDelete,
}: {
  department: DepartmentView;
  canDelete: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      {canDelete ? (
        <ActionForm action={deleteDepartmentAction} className="contents">
          <input type="hidden" name="id" value={department.id} />
          <SubmitButton variant="ghost" size="sm" className="text-danger" pendingLabel="Deleting…">
            Delete
          </SubmitButton>
        </ActionForm>
      ) : null}

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${department.name}`}>
        <ActionForm action={saveDepartmentAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <DepartmentFields department={department} state={state} />
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
    </div>
  );
}
