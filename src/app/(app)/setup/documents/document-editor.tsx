"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Button, Checkbox, Field, FormActions, FormGrid, Input } from "@/components/ui";
import { saveDocumentRequirementAction, toggleDocumentRequirementAction } from "../actions";

type DocItem = {
  id: string;
  code: string;
  label: string;
  isRequired: boolean;
  isActive: boolean;
  sortOrder: number;
};

function DocFields({ item, state }: { item?: DocItem; state: FormState }) {
  const key = item?.id ?? "new";
  return (
    <FormGrid cols={3}>
      {item ? <input type="hidden" name="id" value={item.id} /> : null}
      <Field
        label="Code"
        htmlFor={`code-${key}`}
        required
        hint="UPPER_SNAKE_CASE"
        error={fieldError(state, "code")}
      >
        <Input id={`code-${key}`} name="code" defaultValue={item?.code ?? ""} required />
      </Field>
      <Field label="Label" htmlFor={`label-${key}`} required error={fieldError(state, "label")}>
        <Input id={`label-${key}`} name="label" defaultValue={item?.label ?? ""} required />
      </Field>
      <Field label="Sort order" htmlFor={`order-${key}`} required error={fieldError(state, "sortOrder")}>
        <Input id={`order-${key}`} name="sortOrder" type="number" min={0} defaultValue={item?.sortOrder ?? 0} required />
      </Field>
      <div className="flex items-center gap-2 sm:col-span-3">
        <Checkbox id={`req-${key}`} name="isRequired" defaultChecked={item?.isRequired ?? true} />
        <label htmlFor={`req-${key}`} className="text-sm">
          Expected at enrollment — listed as outstanding until uploaded, but never blocks submission
        </label>
      </div>
    </FormGrid>
  );
}

export function DocumentEditor() {
  return (
    <ActionForm action={saveDocumentRequirementAction} resetOnSuccess>
      {(state) => (
        <>
          <DocFields state={state} />
          <FormActions>
            <SubmitButton pendingLabel="Saving…">Add item</SubmitButton>
          </FormActions>
        </>
      )}
    </ActionForm>
  );
}

export function DocumentRowActions({ item }: { item: DocItem }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <ActionForm action={toggleDocumentRequirementAction} className="contents">
        <input type="hidden" name="id" value={item.id} />
        <SubmitButton variant="ghost" size="sm" pendingLabel="…">
          {item.isActive ? "Deactivate" : "Reactivate"}
        </SubmitButton>
      </ActionForm>

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${item.label}`}>
        <ActionForm action={saveDocumentRequirementAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <DocFields item={item} state={state} />
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
