"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Alert, Button, Field, FormGrid, Input, Select } from "@/components/ui";
import { toDateInput } from "@/lib/dates";
import { paiseToRupees } from "@/lib/money";
import { deleteBatchAction, saveBatchAction } from "../actions";

type Option = { id: string; name: string };
export type BatchView = {
  id: string;
  name: string;
  code: string;
  courseId: string;
  startDate: string;
  completionDate: string;
  totalSeats: number;
  currentFeePaise: number;
  /** Null on a batch created before this was settable — the field offers the institute minimum. */
  registrationFeePaise: number | null;
  status: "UPCOMING" | "ONGOING" | "COMPLETED" | "DISCONTINUED";
};

function BatchFields({
  batch,
  courses,
  state,
  minRegistrationFeePaise,
}: {
  batch?: BatchView;
  courses: Option[];
  state: FormState;
  /** The institute-wide floor, offered as the starting value. */
  minRegistrationFeePaise: number;
}) {
  const key = batch?.id ?? "new";
  return (
    <div className="space-y-4">
      {batch ? <input type="hidden" name="id" value={batch.id} /> : null}
      <FormGrid>
        <Field label="Batch name" htmlFor={`name-${key}`} required error={fieldError(state, "name")}>
          <Input id={`name-${key}`} name="name" defaultValue={batch?.name ?? ""} required />
        </Field>
        <Field label="Code" htmlFor={`code-${key}`} required error={fieldError(state, "code")}>
          <Input id={`code-${key}`} name="code" defaultValue={batch?.code ?? ""} required />
        </Field>
        <Field
          label="Course"
          htmlFor={`course-${key}`}
          required
          hint={batch ? "Semesters were generated from this course and cannot be regenerated." : undefined}
          error={fieldError(state, "courseId")}
        >
          <Select id={`course-${key}`} name="courseId" defaultValue={batch?.courseId ?? ""} required disabled={Boolean(batch)}>
            <option value="">Select a course…</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </Select>
          {batch ? <input type="hidden" name="courseId" value={batch.courseId} /> : null}
        </Field>
        <Field label="Status" htmlFor={`status-${key}`} required error={fieldError(state, "status")}>
          <Select id={`status-${key}`} name="status" defaultValue={batch?.status ?? "UPCOMING"}>
            <option value="UPCOMING">Upcoming</option>
            <option value="ONGOING">Ongoing</option>
            <option value="COMPLETED">Completed</option>
            <option value="DISCONTINUED">Discontinued</option>
          </Select>
        </Field>
        <Field label="Start date" htmlFor={`start-${key}`} required error={fieldError(state, "startDate")}>
          <Input id={`start-${key}`} name="startDate" type="date" defaultValue={toDateInput(batch?.startDate)} required />
        </Field>
        <Field
          label="Batch completion date"
          htmlFor={`end-${key}`}
          required
          hint="Every installment due date must fall on or before this."
          error={fieldError(state, "completionDate")}
        >
          <Input
            id={`end-${key}`}
            name="completionDate"
            type="date"
            defaultValue={toDateInput(batch?.completionDate)}
            required
          />
        </Field>
        <Field label="Total seats" htmlFor={`seats-${key}`} required error={fieldError(state, "totalSeats")}>
          <Input id={`seats-${key}`} name="totalSeats" type="number" min={1} defaultValue={batch?.totalSeats ?? 60} required />
        </Field>
        <Field
          label="Preset batch fee (₹)"
          htmlFor={`fee-${key}`}
          required
          hint="Tuition only. Exam and activity fees are set per semester."
          error={fieldError(state, "tuitionFeePaise")}
        >
          <Input
            id={`fee-${key}`}
            name="tuitionFeePaise"
            inputMode="decimal"
            defaultValue={batch ? String(paiseToRupees(batch.currentFeePaise)) : ""}
            required
          />
        </Field>
        <Field
          label="Registration fee override (₹)"
          htmlFor={`reg-${key}`}
          hint="Leave blank to use the course's registration fee, which is the normal case. Fill it in only for a batch on different terms."
          error={fieldError(state, "registrationFeePaise")}
        >
          <Input
            id={`reg-${key}`}
            name="registrationFeePaise"
            inputMode="decimal"
            placeholder="Uses the course fee"
            defaultValue={
              batch?.registrationFeePaise != null ? String(paiseToRupees(batch.registrationFeePaise)) : ""
            }
          />
        </Field>
      </FormGrid>
      {batch ? (
        <Alert tone="info">
          Changing the preset fee records a new version effective today. Students already enrolled keep the rate locked
          at their enrollment date. Moving the completion date earlier re-flows unpaid installment due dates to fit.
        </Alert>
      ) : null}
    </div>
  );
}

export function BatchEditor({
  courses,
  minRegistrationFeePaise,
}: {
  courses: Option[];
  minRegistrationFeePaise: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        New batch
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New batch"
        description="Semesters are generated automatically from the course's semester count."
        width="lg"
      >
        <ActionForm action={saveBatchAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <BatchFields courses={courses} state={state} minRegistrationFeePaise={minRegistrationFeePaise} />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Creating…">Create batch</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

export function BatchRowActions({
  batch,
  courses,
  canDelete,
  minRegistrationFeePaise,
}: {
  batch: BatchView;
  courses: Option[];
  canDelete: boolean;
  minRegistrationFeePaise: number;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit batch
      </Button>
      {canDelete ? (
        <ActionForm action={deleteBatchAction} className="contents">
          <input type="hidden" name="id" value={batch.id} />
          <SubmitButton variant="ghost" size="sm" className="text-danger" pendingLabel="Deleting…">
            Delete
          </SubmitButton>
        </ActionForm>
      ) : null}

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${batch.name}`} width="lg">
        <ActionForm action={saveBatchAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <BatchFields
                batch={batch}
                courses={courses}
                state={state}
                minRegistrationFeePaise={minRegistrationFeePaise}
              />
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Saving…">Save batch</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </div>
  );
}
