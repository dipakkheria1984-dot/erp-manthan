"use client";

import { useState } from "react";
import { Button, Field, FormGrid, Input, Select } from "@/components/ui";
import { StudentPicker } from "./student-picker";

type Option = { id: string; name: string; parentId?: string };

export function ReportFilters({
  reportKey,
  filters,
  defaults,
  departments,
  courses,
  batches,
  semesters,
  academicYears,
  collectors,
  students,
}: {
  reportKey: string;
  filters: string[];
  defaults: Record<string, string>;
  departments: Option[];
  courses: Option[];
  batches: Option[];
  semesters: Option[];
  academicYears: Option[];
  collectors: Option[];
  students: Option[];
}) {
  // Course/batch/semester lists narrow to the selection above them.
  const [departmentId, setDepartmentId] = useState(defaults.departmentId ?? "");
  const [courseId, setCourseId] = useState(defaults.courseId ?? "");
  const [batchId, setBatchId] = useState(defaults.batchId ?? "");

  const visibleCourses = courses.filter((c) => !departmentId || c.parentId === departmentId);
  const visibleBatches = batches.filter((b) => !courseId || b.parentId === courseId);
  const visibleSemesters = semesters.filter((s) => !batchId || s.parentId === batchId);

  const has = (name: string) => filters.includes(name);

  return (
    <form method="get" className="space-y-4">
      <FormGrid cols={4}>
        {has("student") ? (
          <Field
            label="Student"
            htmlFor="studentId"
            required
            hint={`${students.length} student(s) — type a name or student ID`}
            className="sm:col-span-2"
          >
            <StudentPicker
              id="studentId"
              name="studentId"
              students={students}
              defaultValue={defaults.studentId ?? ""}
            />
          </Field>
        ) : null}

        {has("department") ? (
          <Field label="Department" htmlFor="departmentId">
            <Select
              id="departmentId"
              name="departmentId"
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value);
                setCourseId("");
                setBatchId("");
              }}
            >
              <option value="">All departments</option>
              {departments.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {has("course") ? (
          <Field label="Course" htmlFor="courseId">
            <Select
              id="courseId"
              name="courseId"
              value={courseId}
              onChange={(e) => {
                setCourseId(e.target.value);
                setBatchId("");
              }}
            >
              <option value="">All courses</option>
              {visibleCourses.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {has("batch") ? (
          <Field label="Batch" htmlFor="batchId">
            <Select id="batchId" name="batchId" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">All batches</option>
              {visibleBatches.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {has("semester") ? (
          <Field label="Semester" htmlFor="semesterId">
            <Select id="semesterId" name="semesterId" defaultValue={defaults.semesterId ?? ""}>
              <option value="">All semesters</option>
              {visibleSemesters.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {has("academicYear") ? (
          <Field label="Academic year" htmlFor="academicYearId">
            <Select id="academicYearId" name="academicYearId" defaultValue={defaults.academicYearId ?? ""}>
              <option value="">All years</option>
              {academicYears.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {has("status") ? (
          <Field label="Student status" htmlFor="status" hint="Defaults to active and passed only.">
            <Select id="status" name="status" defaultValue={defaults.status ?? ""}>
              <option value="">Active and passed</option>
              <option value="ACTIVE">Active</option>
              <option value="PASSED">Passed</option>
              <option value="DROPPED_OUT">Dropped-out</option>
              <option value="EXPELLED">Expelled</option>
            </Select>
          </Field>
        ) : null}

        {has("gender") ? (
          <Field label="Gender" htmlFor="gender">
            <Select id="gender" name="gender" defaultValue={defaults.gender ?? ""}>
              <option value="">All</option>
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
        ) : null}

        {has("mode") ? (
          <Field label="Payment mode" htmlFor="mode">
            <Select id="mode" name="mode" defaultValue={defaults.mode ?? ""}>
              <option value="">All modes</option>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CHEQUE">Cheque</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
        ) : null}

        {has("collectedBy") ? (
          <Field label="Collected by" htmlFor="collectedById">
            <Select id="collectedById" name="collectedById" defaultValue={defaults.collectedById ?? ""}>
              <option value="">Anyone</option>
              {collectors.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {has("dueStatus") ? (
          <Field
            label="Dues to show"
            htmlFor="dueStatus"
            hint="“Due now” lists only students with something payable today. “Due this month” lists installments falling due this calendar month, and adds a Due This Month column."
          >
            <Select id="dueStatus" name="dueStatus" defaultValue={defaults.dueStatus ?? ""}>
              <option value="">All dues</option>
              <option value="current">Due now only</option>
              <option value="future">Not yet due only</option>
              <option value="month">Due this month</option>
            </Select>
          </Field>
        ) : null}

        {has("overdueBucket") ? (
          <Field label="Overdue bucket" htmlFor="overdueBucket">
            <Select id="overdueBucket" name="overdueBucket" defaultValue={defaults.overdueBucket ?? ""}>
              <option value="">All</option>
              <option value="not-due">Not yet due</option>
              <option value="0-7">0–7 days</option>
              <option value="8-15">8–15 days</option>
              <option value="16-30">16–30 days</option>
              <option value="30+">30+ days</option>
            </Select>
          </Field>
        ) : null}

        {has("lateFeeOnly") ? (
          <Field label="Late fee" htmlFor="lateFeeOnly">
            <Select id="lateFeeOnly" name="lateFeeOnly" defaultValue={defaults.lateFeeOnly ?? ""}>
              <option value="">With or without</option>
              <option value="with">With late fee</option>
              <option value="without">Without late fee</option>
            </Select>
          </Field>
        ) : null}

        {has("dateRange") ? (
          <>
            <Field label="From" htmlFor="from">
              <Input id="from" name="from" type="date" defaultValue={defaults.from ?? ""} />
            </Field>
            <Field label="To" htmlFor="to">
              <Input id="to" name="to" type="date" defaultValue={defaults.to ?? ""} />
            </Field>
          </>
        ) : null}
      </FormGrid>

      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Run report
        </Button>
        <Button type="submit" size="sm" variant="secondary" formAction={`/reports/${reportKey}`}>
          Reset
        </Button>
      </div>
    </form>
  );
}
