"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError } from "@/components/form";
import { Button, Field, FormActions, FormGrid, Input, Select } from "@/components/ui";
import { toDateInput } from "@/lib/dates";
import { paiseToRupees } from "@/lib/money";
import { reviseBatchFeeAction, saveSemesterAction } from "../../actions";

export function FeeRevisionForm({ batchId }: { batchId: string }) {
  return (
    <ActionForm action={reviseBatchFeeAction} resetOnSuccess>
      {(state) => (
        <>
          <input type="hidden" name="batchId" value={batchId} />
          <FormGrid cols={3}>
            <Field label="New tuition fee (₹)" htmlFor="revFee" required error={fieldError(state, "tuitionFeePaise")}>
              <Input id="revFee" name="tuitionFeePaise" inputMode="decimal" required />
            </Field>
            <Field
              label="Effective from"
              htmlFor="revFrom"
              required
              hint="Students enrolled before this date keep their locked rate."
              error={fieldError(state, "effectiveFrom")}
            >
              <Input id="revFrom" name="effectiveFrom" type="date" defaultValue={toDateInput(new Date())} required />
            </Field>
            <Field label="Note" htmlFor="revNote" error={fieldError(state, "note")}>
              <Input id="revNote" name="note" placeholder="e.g. 2026 fee circular" />
            </Field>
          </FormGrid>
          <FormActions>
            <SubmitButton pendingLabel="Recording…">Record revision</SubmitButton>
          </FormActions>
        </>
      )}
    </ActionForm>
  );
}

type SemesterView = {
  id: string;
  semesterNumber: number;
  startDate: string;
  endDate: string;
  examFeePaise: number;
  activityFeePaise: number;
  academicYearId: string | null;
};

export function SemesterRowActions({
  semester,
  academicYears,
}: {
  semester: SemesterView;
  academicYears: { id: string; name: string }[];
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      <Modal open={editing} onClose={() => setEditing(false)} title={`Semester ${semester.semesterNumber}`}>
        <ActionForm action={saveSemesterAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <input type="hidden" name="id" value={semester.id} />
              <FormGrid>
                <Field label="Start date" htmlFor="semStart" required error={fieldError(state, "startDate")}>
                  <Input id="semStart" name="startDate" type="date" defaultValue={toDateInput(semester.startDate)} required />
                </Field>
                <Field label="End date" htmlFor="semEnd" required error={fieldError(state, "endDate")}>
                  <Input id="semEnd" name="endDate" type="date" defaultValue={toDateInput(semester.endDate)} required />
                </Field>
                <Field label="Exam fee (₹)" htmlFor="semExam" error={fieldError(state, "examFeePaise")}>
                  <Input
                    id="semExam"
                    name="examFeePaise"
                    inputMode="decimal"
                    defaultValue={String(paiseToRupees(semester.examFeePaise))}
                  />
                </Field>
                <Field label="Activity fee (₹)" htmlFor="semActivity" error={fieldError(state, "activityFeePaise")}>
                  <Input
                    id="semActivity"
                    name="activityFeePaise"
                    inputMode="decimal"
                    defaultValue={String(paiseToRupees(semester.activityFeePaise))}
                  />
                </Field>
                <Field
                  label="Academic year"
                  htmlFor="semYear"
                  hint="Which session's exam/activity rates this semester belongs to."
                  error={fieldError(state, "academicYearId")}
                  className="sm:col-span-2"
                >
                  <Select id="semYear" name="academicYearId" defaultValue={semester.academicYearId ?? ""}>
                    <option value="">Not set</option>
                    {academicYears.map((year) => (
                      <option key={year.id} value={year.id}>
                        {year.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FormGrid>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Saving…">Save semester</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
