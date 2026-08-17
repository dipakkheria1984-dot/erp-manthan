"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Card, Field, FormActions, FormGrid, Select } from "@/components/ui";
import { savePortalCourseAction } from "../../actions";

type Option = { id: string; name: string; parentId?: string };

/**
 * Department and course, and nothing else.
 *
 * The batch is not offered: it decides the seat, the tuition rate and the
 * academic year, and it is the office that knows which one has room. Leaving it
 * out is what makes this form safe to hand to the public.
 */
export function CourseForm({
  token,
  departments,
  courses,
  departmentId,
  courseId,
}: {
  token: string;
  departments: Option[];
  courses: Option[];
  departmentId: string | null;
  courseId: string | null;
}) {
  const [department, setDepartment] = useState(departmentId ?? "");
  const visibleCourses = courses.filter((course) => !department || course.parentId === department);

  return (
    <ActionForm action={savePortalCourseAction}>
      {(state) => (
        <Card
          title="What do you want to study?"
          description="Choose your department and course. The admissions office will place you in a batch."
        >
          <input type="hidden" name="token" value={token} />
          <FormGrid>
            <Field label="Department" htmlFor="departmentId" required error={fieldError(state, "departmentId")}>
              <Select
                id="departmentId"
                name="departmentId"
                value={department}
                onChange={(event) => setDepartment(event.target.value)}
                required
              >
                <option value="">Select…</option>
                {departments.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Course" htmlFor="courseId" required error={fieldError(state, "courseId")}>
              <Select id="courseId" name="courseId" defaultValue={courseId ?? ""} required>
                <option value="">Select…</option>
                {visibleCourses.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>
          </FormGrid>
          <FormActions>
            <SubmitButton pendingLabel="Saving…">Save and continue</SubmitButton>
          </FormActions>
        </Card>
      )}
    </ActionForm>
  );
}
