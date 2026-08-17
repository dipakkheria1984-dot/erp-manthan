"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Button, Card, Checkbox, Field, FormActions, FormGrid, Input, Select } from "@/components/ui";
import { deletePortalGuardianAction, savePortalGuardianAction } from "../../actions";

export type GuardianView = {
  id: string;
  relation: "FATHER" | "MOTHER" | "GUARDIAN";
  name: string;
  occupation: string | null;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
};

function GuardianFields({
  token,
  guardian,
  state,
}: {
  token: string;
  guardian?: GuardianView;
  state: FormState;
}) {
  const key = guardian?.id ?? "new";
  return (
    <FormGrid>
      <input type="hidden" name="token" value={token} />
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
          Main person for us to contact
        </label>
      </div>
    </FormGrid>
  );
}

/**
 * Adding is an always-visible form rather than a button that opens a dialog:
 * most applicants add one or two guardians and then move on, and a form already
 * on the page is one less thing to discover on a phone.
 */
export function AddGuardian({ token }: { token: string }) {
  // Remounts the form after a successful save so the fields come back empty
  // ready for the next guardian, instead of holding the previous one's details.
  const [round, setRound] = useState(0);

  return (
    <Card title="Add a parent or guardian">
      <ActionForm key={round} action={savePortalGuardianAction} onSuccess={() => setRound((n) => n + 1)}>
        {(state) => (
          <>
            <GuardianFields token={token} state={state} />
            <FormActions>
              <SubmitButton pendingLabel="Saving…">Add</SubmitButton>
            </FormActions>
          </>
        )}
      </ActionForm>
    </Card>
  );
}

export function GuardianRowActions({ token, guardian }: { token: string; guardian: GuardianView }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <ActionForm action={deletePortalGuardianAction} className="contents">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="guardianId" value={guardian.id} />
        <SubmitButton variant="ghost" size="sm" className="text-danger" pendingLabel="Removing…">
          Remove
        </SubmitButton>
      </ActionForm>

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${guardian.name}`}>
        <ActionForm action={savePortalGuardianAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <GuardianFields token={token} guardian={guardian} state={state} />
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
