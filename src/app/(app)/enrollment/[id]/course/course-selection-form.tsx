"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Alert, Card, Field, FormActions, FormGrid, Input, Select } from "@/components/ui";
import { saveCourseSelectionAction } from "../../actions";

type Values = {
  academicYearId: string | null;
  departmentId: string | null;
  courseId: string | null;
  batchId: string | null;
  requestedScholarshipPercent: number;
  requestedScholarshipPaise: number;
  scholarshipNeedsApproval: boolean;
};

export function CourseSelectionForm({
  applicationId,
  values,
  academicYears,
  departments,
  courses,
  batches,
}: {
  applicationId: string;
  values: Values;
  academicYears: { id: string; name: string; isCurrent: boolean }[];
  departments: { id: string; name: string }[];
  courses: { id: string; name: string; departmentId: string }[];
  batches: { id: string; name: string; courseId: string; seatsLeft: number }[];
}) {
  const [departmentId, setDepartmentId] = useState(values.departmentId ?? "");
  const [courseId, setCourseId] = useState(values.courseId ?? "");
  const [basis, setBasis] = useState<"PERCENT" | "AMOUNT">(values.requestedScholarshipPaise > 0 ? "AMOUNT" : "PERCENT");

  const visibleCourses = courses.filter((c) => !departmentId || c.departmentId === departmentId);
  const visibleBatches = batches.filter((b) => !courseId || b.courseId === courseId);
  const defaultYear = values.academicYearId ?? academicYears.find((y) => y.isCurrent)?.id ?? "";

  return (
    <ActionForm action={saveCourseSelectionAction}>
      {(state) => (
        <Card title="Course, batch and scholarship">
          <input type="hidden" name="id" value={applicationId} />
          <FormGrid>
            <Field label="Academic year" htmlFor="academicYearId" required error={fieldError(state, "academicYearId")}>
              <Select id="academicYearId" name="academicYearId" defaultValue={defaultYear} required>
                <option value="">Select…</option>
                {academicYears.map((year) => (
                  <option key={year.id} value={year.id}>
                    {year.name}
                    {year.isCurrent ? " (current)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Department" htmlFor="departmentId" required error={fieldError(state, "departmentId")}>
              <Select
                id="departmentId"
                name="departmentId"
                value={departmentId}
                onChange={(e) => {
                  setDepartmentId(e.target.value);
                  setCourseId("");
                }}
                required
              >
                <option value="">Select…</option>
                {departments.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Course" htmlFor="courseId" required error={fieldError(state, "courseId")}>
              <Select
                id="courseId"
                name="courseId"
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
                required
                disabled={!departmentId}
              >
                <option value="">Select…</option>
                {visibleCourses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Batch"
              htmlFor="batchId"
              required
              hint="Batches with no seats left cannot be chosen — there is no waitlist."
              error={fieldError(state, "batchId")}
            >
              <Select id="batchId" name="batchId" defaultValue={values.batchId ?? ""} required disabled={!courseId}>
                <option value="">Select…</option>
                {visibleBatches.map((batch) => (
                  <option key={batch.id} value={batch.id} disabled={batch.seatsLeft <= 0}>
                    {batch.name} — {batch.seatsLeft > 0 ? `${batch.seatsLeft} seats left` : "full"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Scholarship / discount given as" htmlFor="scholarshipBasis">
              <Select
                id="scholarshipBasis"
                name="scholarshipBasis"
                value={basis}
                onChange={(e) => setBasis(e.target.value as "PERCENT" | "AMOUNT")}
              >
                <option value="PERCENT">A percentage of the batch fee</option>
                <option value="AMOUNT">A fixed amount</option>
              </Select>
            </Field>
            {basis === "PERCENT" ? (
              <Field
                label="Scholarship / discount (%)"
                htmlFor="requestedScholarshipPercent"
                hint="Applies to the first year's tuition only. Leave it at 0 — or blank — where there is no concession."
                error={fieldError(state, "requestedScholarshipPercent")}
              >
                <Input
                  id="requestedScholarshipPercent"
                  name="requestedScholarshipPercent"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={values.requestedScholarshipPercent}
                />
              </Field>
            ) : (
              <Field
                label="Scholarship / discount (₹)"
                htmlFor="requestedScholarshipAmount"
                hint="A flat concession on the first year's tuition. Cannot exceed the batch fee."
                error={fieldError(state, "requestedScholarshipAmount")}
              >
                <Input
                  id="requestedScholarshipAmount"
                  name="requestedScholarshipAmount"
                  inputMode="decimal"
                  defaultValue={values.requestedScholarshipPaise > 0 ? values.requestedScholarshipPaise / 100 : ""}
                />
              </Field>
            )}
          </FormGrid>

          {values.scholarshipNeedsApproval ? (
            <div className="mt-4">
              {/* The configured threshold is deliberately never shown here. */}
              <Alert tone="warning" title="This discount requires Admin approval">
                The application will move to Under Review on submission and an Admin will decide the final scholarship.
              </Alert>
            </div>
          ) : null}

          <FormActions>
            <SubmitButton pendingLabel="Saving…">Save selection</SubmitButton>
          </FormActions>
        </Card>
      )}
    </ActionForm>
  );
}
