"use client";

import { useState } from "react";
import { ActionForm, Modal, SubmitButton, fieldError, type FormState } from "@/components/form";
import { Button, Field, FormGrid, Input, Select } from "@/components/ui";
import { deleteCourseAction, saveCourseAction } from "../actions";

type Option = { id: string; name: string };
type CourseView = {
  id: string;
  name: string;
  code: string;
  departmentId: string;
  durationYears: number;
  totalSemesters: number;
  status: "ACTIVE" | "INACTIVE" | "DISCONTINUED";
};

function CourseFields({
  course,
  departments,
  semesterCountLocked,
  state,
}: {
  course?: CourseView;
  departments: Option[];
  semesterCountLocked?: boolean;
  state: FormState;
}) {
  const key = course?.id ?? "new";
  return (
    <FormGrid>
      {course ? <input type="hidden" name="id" value={course.id} /> : null}
      <Field label="Name" htmlFor={`name-${key}`} required error={fieldError(state, "name")}>
        <Input id={`name-${key}`} name="name" defaultValue={course?.name ?? ""} required />
      </Field>
      <Field label="Code" htmlFor={`code-${key}`} required error={fieldError(state, "code")}>
        <Input id={`code-${key}`} name="code" defaultValue={course?.code ?? ""} required />
      </Field>
      <Field label="Department" htmlFor={`dept-${key}`} required error={fieldError(state, "departmentId")}>
        <Select id={`dept-${key}`} name="departmentId" defaultValue={course?.departmentId ?? ""} required>
          <option value="">Select a department…</option>
          {departments.map((dept) => (
            <option key={dept.id} value={dept.id}>
              {dept.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Status" htmlFor={`status-${key}`} required error={fieldError(state, "status")}>
        <Select id={`status-${key}`} name="status" defaultValue={course?.status ?? "ACTIVE"}>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option value="DISCONTINUED">Discontinued</option>
        </Select>
      </Field>
      <Field label="Duration (years)" htmlFor={`years-${key}`} required error={fieldError(state, "durationYears")}>
        <Input
          id={`years-${key}`}
          name="durationYears"
          type="number"
          min={1}
          max={10}
          defaultValue={course?.durationYears ?? 3}
          required
        />
      </Field>
      <Field
        label="Total semesters"
        htmlFor={`sems-${key}`}
        required
        hint={semesterCountLocked ? "Locked — batches already exist under this course." : "Minimum 2."}
        error={fieldError(state, "totalSemesters")}
      >
        <Input
          id={`sems-${key}`}
          name="totalSemesters"
          type="number"
          min={2}
          max={20}
          defaultValue={course?.totalSemesters ?? 6}
          readOnly={semesterCountLocked}
          required
        />
      </Field>
    </FormGrid>
  );
}

export function CourseEditor({ departments }: { departments: Option[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        New course
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="New course">
        <ActionForm action={saveCourseAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <CourseFields departments={departments} state={state} />
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

export function CourseRowActions({
  course,
  departments,
  semesterCountLocked,
  canDelete,
}: {
  course: CourseView;
  departments: Option[];
  semesterCountLocked: boolean;
  canDelete: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
      {canDelete ? (
        <ActionForm action={deleteCourseAction} className="contents">
          <input type="hidden" name="id" value={course.id} />
          <SubmitButton variant="ghost" size="sm" className="text-danger" pendingLabel="Deleting…">
            Delete
          </SubmitButton>
        </ActionForm>
      ) : null}

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${course.name}`}>
        <ActionForm action={saveCourseAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <CourseFields
                course={course}
                departments={departments}
                semesterCountLocked={semesterCountLocked}
                state={state}
              />
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
