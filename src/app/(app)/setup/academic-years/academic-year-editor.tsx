"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Button, Checkbox, Field, FormActions, FormGrid, Input } from "@/components/ui";
import { toDateInput } from "@/lib/dates";
import { saveAcademicYearAction } from "../actions";

type YearView = { id: string; name: string; startDate: string; endDate: string; isCurrent: boolean };

function YearFields({ year, state }: { year?: YearView; state: FormState }) {
  const key = year?.id ?? "new";
  return (
    <FormGrid cols={3}>
      {year ? <input type="hidden" name="id" value={year.id} /> : null}
      <Field label="Name" htmlFor={`name-${key}`} required hint="e.g. 2025-26" error={fieldError(state, "name")}>
        <Input id={`name-${key}`} name="name" defaultValue={year?.name ?? ""} required />
      </Field>
      <Field label="Start date" htmlFor={`start-${key}`} required error={fieldError(state, "startDate")}>
        <Input id={`start-${key}`} name="startDate" type="date" defaultValue={toDateInput(year?.startDate)} required />
      </Field>
      <Field label="End date" htmlFor={`end-${key}`} required error={fieldError(state, "endDate")}>
        <Input id={`end-${key}`} name="endDate" type="date" defaultValue={toDateInput(year?.endDate)} required />
      </Field>
      <div className="flex items-center gap-2 sm:col-span-3">
        <Checkbox id={`current-${key}`} name="isCurrent" defaultChecked={year?.isCurrent ?? false} />
        <label htmlFor={`current-${key}`} className="text-sm">
          Set as the current academic year
        </label>
      </div>
    </FormGrid>
  );
}

export function AcademicYearEditor() {
  return (
    <ActionForm action={saveAcademicYearAction} resetOnSuccess>
      {(state) => (
        <>
          <YearFields state={state} />
          <FormActions>
            <SubmitButton pendingLabel="Saving…">Add academic year</SubmitButton>
          </FormActions>
        </>
      )}
    </ActionForm>
  );
}

export function AcademicYearRowActions({ year }: { year: YearView }) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${year.name}`}>
        <ActionForm action={saveAcademicYearAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <YearFields year={year} state={state} />
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
    </>
  );
}
