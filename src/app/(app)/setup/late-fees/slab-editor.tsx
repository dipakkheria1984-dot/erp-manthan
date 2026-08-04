"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError } from "@/components/form";
import { Button, Field, FormActions, FormGrid, Input } from "@/components/ui";
import { paiseToRupees } from "@/lib/money";
import { deleteLateFeeSlabAction, saveLateFeeSlabAction } from "../actions";

type Slab = { id: number; minDaysOverdue: number; maxDaysOverdue: number | null; amountPaise: number };

function SlabFields({ slab, state }: { slab?: Slab; state: Parameters<typeof fieldError>[0] }) {
  return (
    <FormGrid cols={3}>
      {slab ? <input type="hidden" name="id" value={slab.id} /> : null}
      <Field label="From day" htmlFor={`min-${slab?.id ?? "new"}`} required error={fieldError(state, "minDaysOverdue")}>
        <Input
          id={`min-${slab?.id ?? "new"}`}
          name="minDaysOverdue"
          type="number"
          min={1}
          defaultValue={slab?.minDaysOverdue ?? 1}
          required
        />
      </Field>
      <Field
        label="To day"
        htmlFor={`max-${slab?.id ?? "new"}`}
        hint="Leave blank for the open-ended final slab."
        error={fieldError(state, "maxDaysOverdue")}
      >
        <Input
          id={`max-${slab?.id ?? "new"}`}
          name="maxDaysOverdue"
          type="number"
          min={1}
          defaultValue={slab?.maxDaysOverdue ?? ""}
        />
      </Field>
      <Field label="Late fee (₹)" htmlFor={`amt-${slab?.id ?? "new"}`} required error={fieldError(state, "amountPaise")}>
        <Input
          id={`amt-${slab?.id ?? "new"}`}
          name="amountPaise"
          inputMode="decimal"
          defaultValue={slab ? String(paiseToRupees(slab.amountPaise)) : ""}
          required
        />
      </Field>
    </FormGrid>
  );
}

export function SlabEditor() {
  return (
    <ActionForm action={saveLateFeeSlabAction} resetOnSuccess>
      {(state) => (
        <>
          <SlabFields state={state} />
          <FormActions>
            <SubmitButton pendingLabel="Saving…">Add slab</SubmitButton>
          </FormActions>
        </>
      )}
    </ActionForm>
  );
}

export function SlabRowActions({ slab }: { slab: Slab }) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <ActionForm action={deleteLateFeeSlabAction} className="contents">
        <input type="hidden" name="id" value={slab.id} />
        <SubmitButton variant="ghost" size="sm" className="text-danger" pendingLabel="Removing…">
          Remove
        </SubmitButton>
      </ActionForm>

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit late fee slab">
        <ActionForm action={saveLateFeeSlabAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <SlabFields slab={slab} state={state} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Saving…">Save slab</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </div>
  );
}
