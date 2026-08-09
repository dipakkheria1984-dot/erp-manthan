"use client";

import { useState } from "react";
import { Button, Field, FormGrid, Select } from "@/components/ui";

export type TargetBatchOption = {
  id: string;
  name: string;
  code: string;
  courseId: string;
  seatsLeft: number;
};

/**
 * Which course the student is moving to, chosen before anything is filled in.
 *
 * This navigates rather than submits: the batch decides the tuition rate, the
 * semesters on offer and the last date an installment may fall on, and all
 * three are read on the server. Only the batch reaches the URL — the department
 * and course boxes above it just narrow the list.
 */
export function TargetPicker({
  studentId,
  departments,
  courses,
  batches,
  selectedBatchId,
}: {
  studentId: string;
  departments: { id: string; name: string }[];
  courses: { id: string; name: string; departmentId: string }[];
  batches: TargetBatchOption[];
  selectedBatchId: string;
}) {
  const selected = batches.find((batch) => batch.id === selectedBatchId);
  const selectedCourse = courses.find((course) => course.id === selected?.courseId);

  const [departmentId, setDepartmentId] = useState(selectedCourse?.departmentId ?? "");
  const [courseId, setCourseId] = useState(selectedCourse?.id ?? "");

  const visibleCourses = courses.filter((course) => !departmentId || course.departmentId === departmentId);
  const visibleBatches = batches.filter((batch) => !courseId || batch.courseId === courseId);

  return (
    <form method="get" className="space-y-4">
      <input type="hidden" name="studentId" value={studentId} />
      <FormGrid cols={3}>
        <Field label="New department" htmlFor="targetDepartment">
          <Select
            id="targetDepartment"
            value={departmentId}
            onChange={(e) => {
              setDepartmentId(e.target.value);
              setCourseId("");
            }}
          >
            <option value="">Select…</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="New course" htmlFor="targetCourse">
          <Select
            id="targetCourse"
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
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
          label="New batch"
          htmlFor="targetBatch"
          hint="A batch with no seats left cannot be joined — there is no waitlist."
        >
          <Select id="targetBatch" name="batchId" defaultValue={selectedBatchId} disabled={!courseId} required>
            <option value="">Select…</option>
            {visibleBatches.map((batch) => (
              <option key={batch.id} value={batch.id} disabled={batch.seatsLeft <= 0}>
                {batch.name} ({batch.code}) — {batch.seatsLeft > 0 ? `${batch.seatsLeft} seats left` : "full"}
              </option>
            ))}
          </Select>
        </Field>
      </FormGrid>
      <Button type="submit" variant="secondary" disabled={!courseId}>
        Continue
      </Button>
    </form>
  );
}
