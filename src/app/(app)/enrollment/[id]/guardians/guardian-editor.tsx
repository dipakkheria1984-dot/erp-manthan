"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Button, Checkbox, Field, FormGrid, Input, Select } from "@/components/ui";
import { deleteGuardianAction, saveGuardianAction } from "../../actions";

type GuardianView = {
  id: string;
  relation: "FATHER" | "MOTHER" | "GUARDIAN";
  name: string;
  occupation: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
};

function GuardianFields({
  applicationId,
  guardian,
  state,
}: {
  applicationId: string;
  guardian?: GuardianView;
  state: FormState;
}) {
  const key = guardian?.id ?? "new";
  return (
    <FormGrid>
      <input type="hidden" name="applicationId" value={applicationId} />
      {guardian ? <input type="hidden" name="guardianId" value={guardian.id} /> : null}
      <Field label="Relationship" htmlFor={`rel-${key}`} required error={fieldError(state, "relation")}>
        <Select id={`rel-${key}`} name="relation" defaultValue={guardian?.relation ?? "FATHER"}>
          <option value="FATHER">Father</option>
          <option value="MOTHER">Mother</option>
          <option value="GUARDIAN">Guardian</option>
        </Select>
      </Field>
      <Field label="Name" htmlFor={`gname-${key}`} required error={fieldError(state, "name")}>
        <Input id={`gname-${key}`} name="name" defaultValue={guardian?.name ?? ""} required />
      </Field>
      <Field label="Occupation" htmlFor={`occ-${key}`} error={fieldError(state, "occupation")}>
        <Input id={`occ-${key}`} name="occupation" defaultValue={guardian?.occupation ?? ""} />
      </Field>
      <Field label="Phone" htmlFor={`gphone-${key}`} error={fieldError(state, "phone")}>
        <Input id={`gphone-${key}`} name="phone" defaultValue={guardian?.phone ?? ""} />
      </Field>
      <Field label="Email" htmlFor={`gemail-${key}`} error={fieldError(state, "email")}>
        <Input id={`gemail-${key}`} name="email" type="email" defaultValue={guardian?.email ?? ""} />
      </Field>
      <div className="flex items-center gap-2 pt-7">
        <Checkbox id={`prim-${key}`} name="isPrimary" defaultChecked={guardian?.isPrimary ?? false} />
        <label htmlFor={`prim-${key}`} className="text-sm">
          Primary contact for notifications
        </label>
      </div>
    </FormGrid>
  );
}

export function GuardianEditor({ applicationId }: { applicationId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Add guardian
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add guardian">
        <ActionForm action={saveGuardianAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <GuardianFields applicationId={applicationId} state={state} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Saving…">Add</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

export function GuardianRowActions({
  applicationId,
  guardian,
}: {
  applicationId: string;
  guardian: GuardianView;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <ActionForm action={deleteGuardianAction} className="contents">
        <input type="hidden" name="guardianId" value={guardian.id} />
        <SubmitButton variant="ghost" size="sm" className="text-danger" pendingLabel="Removing…">
          Remove
        </SubmitButton>
      </ActionForm>

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${guardian.name}`}>
        <ActionForm action={saveGuardianAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <GuardianFields applicationId={applicationId} guardian={guardian} state={state} />
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
