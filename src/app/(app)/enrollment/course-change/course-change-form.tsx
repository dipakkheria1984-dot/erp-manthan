"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import {
  Alert,
  Button,
  Card,
  Field,
  FormGrid,
  Input,
  Select,
  StatTile,
  TableWrap,
  Td,
  Textarea,
  Th,
  Tr,
} from "@/components/ui";
import { addMonths, fromDateInput, toDateInput } from "@/lib/dates";
import { formatPaise, paiseToRupees, rupeesToPaise, splitPaise } from "@/lib/money";
import { changeCourseAction } from "./actions";

/** A semester of the batch the student is joining, with its presets. */
export type TargetSemester = {
  id: string;
  label: string;
  /** Rupee strings prefilled when the semester is chosen. */
  tuition: string;
  examFee: string;
  activityFee: string;
  hint: string;
};

type PlanRow = { dueDate: string; amount: string };

const asPaise = (value: string): number => {
  const cleaned = value.trim().replace(/[,\s₹]/g, "");
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? rupeesToPaise(n) : 0;
};

function scholarshipOf(tuitionPaise: number, basis: "PERCENT" | "AMOUNT", percent: string, amount: string): number {
  if (basis === "AMOUNT") return Math.min(asPaise(amount), tuitionPaise);
  const n = Number.parseInt(percent || "0", 10);
  return Math.round((tuitionPaise * (Number.isFinite(n) ? n : 0)) / 100);
}

/**
 * Monthly due dates from `firstDue`, compressed into an even spread when
 * monthly spacing would overrun the batch completion date. Mirrors
 * `buildInstallmentPlan` on the server, which re-checks whatever is submitted.
 */
function datesFor(count: number, firstDue: string, end: Date): Date[] {
  const start = fromDateInput(firstDue);
  if (Number.isNaN(start.getTime()) || count < 1) return [];
  if (addMonths(start, count - 1) <= end) {
    return Array.from({ length: count }, (_, i) => addMonths(start, i));
  }
  const span = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(start);
    date.setDate(date.getDate() + (count === 1 ? 0 : Math.round((span * i) / (count - 1))));
    return date;
  });
}

function spreadOver(dates: Date[], totalPaise: number): PlanRow[] {
  if (dates.length === 0) return [];
  const amounts = splitPaise(Math.max(0, totalPaise), dates.length);
  return dates.map((date, i) => ({ dueDate: toDateInput(date), amount: paiseToRupees(amounts[i]).toFixed(2) }));
}

/**
 * The new course's fee, and where the money already collected lands on it.
 *
 * The charge is built exactly as enrollment builds it — batch tuition less any
 * scholarship, plus the semester's exam and activity fees — and the plan
 * underneath has to add up to the result. The credit column is the same
 * oldest-first rule the server applies, worked out here so nobody confirms a
 * transfer without seeing what the family's payments will have settled.
 */
export function CourseChangeForm({
  studentId,
  studentCode,
  target,
  semesters,
  defaultSemesterId,
  initialScholarship,
  installmentMin,
  installmentMax,
  defaultInstallmentCount,
  defaultFirstDueDate,
  carriedPaise,
  carriedLateFeePaise,
}: {
  studentId: string;
  studentCode: string;
  target: {
    departmentId: string;
    courseId: string;
    batchId: string;
    courseName: string;
    batchLabel: string;
    /** `yyyy-MM-dd` — no due date may fall after it. */
    completionDate: string;
    completionDateLabel: string;
  };
  semesters: TargetSemester[];
  defaultSemesterId: string;
  initialScholarship: { basis: "PERCENT" | "AMOUNT"; percent: string; amount: string };
  installmentMin: number;
  installmentMax: number;
  defaultInstallmentCount: number;
  defaultFirstDueDate: string;
  carriedPaise: number;
  carriedLateFeePaise: number;
}) {
  const end = fromDateInput(target.completionDate);
  const firstSemester = semesters.find((option) => option.id === defaultSemesterId) ?? semesters[0];

  const [semesterId, setSemesterId] = useState(firstSemester?.id ?? "");
  const [basis, setBasis] = useState<"PERCENT" | "AMOUNT">(initialScholarship.basis);
  const [scholarshipPercent, setScholarshipPercent] = useState(initialScholarship.percent);
  const [scholarshipAmount, setScholarshipAmount] = useState(initialScholarship.amount);
  const [amounts, setAmounts] = useState({
    tuition: firstSemester?.tuition ?? "0.00",
    examFee: firstSemester?.examFee ?? "0.00",
    activityFee: firstSemester?.activityFee ?? "0.00",
  });

  const semester = semesters.find((option) => option.id === semesterId) ?? firstSemester;
  const tuitionPaise = asPaise(amounts.tuition);
  const scholarshipPaise = scholarshipOf(tuitionPaise, basis, scholarshipPercent, scholarshipAmount);
  const totalPaise = tuitionPaise - scholarshipPaise + asPaise(amounts.examFee) + asPaise(amounts.activityFee);

  // The generator's inputs. They are not submitted — the rows they produce are,
  // and every one of those can be edited afterwards.
  const [count, setCount] = useState(String(defaultInstallmentCount));
  const [firstDue, setFirstDue] = useState(defaultFirstDueDate);
  const [rows, setRows] = useState<PlanRow[]>([]);

  const enteredPaise = rows.reduce((sum, row) => sum + asPaise(row.amount), 0);
  const difference = totalPaise - enteredPaise;
  const outsideRange = rows.length < installmentMin || rows.length > installmentMax;

  // Oldest-first, exactly as the server will apply it: each installment is
  // filled from the credit before the next one is touched.
  let creditLeft = carriedPaise;
  const settledByCredit = rows.map((row) => {
    const applied = Math.min(creditLeft, asPaise(row.amount));
    creditLeft -= applied;
    return applied;
  });
  const creditApplied = carriedPaise - creditLeft;
  const stillToCollect = Math.max(0, totalPaise - creditApplied);

  function chooseSemester(id: string) {
    setSemesterId(id);
    const chosen = semesters.find((option) => option.id === id);
    if (!chosen) return;
    setAmounts({ tuition: chosen.tuition, examFee: chosen.examFee, activityFee: chosen.activityFee });
  }

  const regenerate = () => {
    const n = Number.parseInt(count, 10);
    if (!Number.isInteger(n) || n < 1) return;
    setRows(spreadOver(datesFor(n, firstDue, end), totalPaise));
  };

  const spreadEvenly = () => {
    if (rows.length === 0) return;
    setRows(spreadOver(rows.map((row) => fromDateInput(row.dueDate)), totalPaise));
  };

  const setRow = (index: number, patch: Partial<PlanRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const addRow = () => {
    const last = rows[rows.length - 1];
    const next = last ? addMonths(fromDateInput(last.dueDate), 1) : new Date();
    setRows((current) => [...current, { dueDate: toDateInput(next > end ? end : next), amount: "0.00" }]);
  };

  const removeRow = (index: number) => setRows((current) => current.filter((_, i) => i !== index));

  return (
    <ActionForm action={changeCourseAction} className="space-y-6">
      {(state) => (
        <>
          <input type="hidden" name="studentId" value={studentId} />
          <input type="hidden" name="departmentId" value={target.departmentId} />
          <input type="hidden" name="courseId" value={target.courseId} />
          <input type="hidden" name="batchId" value={target.batchId} />
          <input type="hidden" name="scholarshipBasis" value={basis} />
          <input type="hidden" name="rows" value={JSON.stringify(rows)} />

          <Card
            title={`New fee — ${target.courseName}`}
            description={`The batch's tuition less any scholarship, plus the semester's exam and activity fees. This replaces the fee structure ${studentCode} carried on the old course.`}
          >
            <FormGrid cols={3}>
              <Field
                label="Semester joined"
                htmlFor="targetSemester"
                required
                hint={semester?.hint}
                error={fieldError(state, "semesterId")}
              >
                <Select
                  id="targetSemester"
                  name="semesterId"
                  value={semesterId}
                  onChange={(e) => chooseSemester(e.target.value)}
                  required
                >
                  {semesters.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Tuition rate (₹)"
                htmlFor="targetTuition"
                hint={`${target.batchLabel}'s rate today. It is locked to the student from this transfer onwards.`}
                error={fieldError(state, "lockedTuitionRate")}
              >
                <Input
                  id="targetTuition"
                  name="lockedTuitionRate"
                  inputMode="decimal"
                  value={amounts.tuition}
                  onChange={(e) => setAmounts((v) => ({ ...v, tuition: e.target.value }))}
                />
              </Field>
              <Field label="Scholarship" htmlFor="targetScholarshipBasis" hint="Carried over from the old course — adjust it if the concession changes with the course.">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    id="targetScholarshipBasis"
                    value={basis}
                    onChange={(e) => setBasis(e.target.value as "PERCENT" | "AMOUNT")}
                    className="w-auto"
                  >
                    <option value="PERCENT">Percentage</option>
                    <option value="AMOUNT">Fixed amount</option>
                  </Select>
                  {basis === "PERCENT" ? (
                    <Input
                      name="scholarshipPercent"
                      inputMode="numeric"
                      value={scholarshipPercent}
                      onChange={(e) => setScholarshipPercent(e.target.value)}
                      className="w-24"
                      aria-label="Scholarship percent"
                    />
                  ) : (
                    <Input
                      name="scholarshipAmount"
                      inputMode="decimal"
                      value={scholarshipAmount}
                      onChange={(e) => setScholarshipAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-36"
                      aria-label="Scholarship amount in rupees"
                    />
                  )}
                </div>
              </Field>
              <Field label="Exam fee (₹)" htmlFor="targetExamFee" error={fieldError(state, "examFee")}>
                <Input
                  id="targetExamFee"
                  name="examFee"
                  inputMode="decimal"
                  value={amounts.examFee}
                  onChange={(e) => setAmounts((v) => ({ ...v, examFee: e.target.value }))}
                />
              </Field>
              <Field label="Activity fee (₹)" htmlFor="targetActivityFee" error={fieldError(state, "activityFee")}>
                <Input
                  id="targetActivityFee"
                  name="activityFee"
                  inputMode="decimal"
                  value={amounts.activityFee}
                  onChange={(e) => setAmounts((v) => ({ ...v, activityFee: e.target.value }))}
                />
              </Field>
            </FormGrid>

            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Scholarship" value={`− ${formatPaise(scholarshipPaise)}`} />
              <StatTile label="New fee" value={formatPaise(totalPaise)} hint="The plan below must add up to this" />
              <StatTile
                label="Settled by past payments"
                value={formatPaise(creditApplied)}
                tone={creditApplied > 0 ? "success" : "default"}
                hint={
                  carriedPaise > creditApplied
                    ? `${formatPaise(carriedPaise - creditApplied)} held as credit`
                    : `of ${formatPaise(carriedPaise)} collected`
                }
              />
              <StatTile
                label="Still to collect"
                value={formatPaise(stillToCollect)}
                tone={stillToCollect > 0 ? "danger" : "success"}
              />
            </div>
          </Card>

          <Card
            title="Installments for the new course"
            description={`Between ${installmentMin} and ${installmentMax}, in date order, every due date on or before ${target.completionDateLabel}. Money already collected settles them oldest first, so the first installments may be paid the moment they are written.`}
            actions={
              <div className="flex flex-wrap items-end gap-2">
                <Input
                  inputMode="numeric"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  className="w-20"
                  aria-label="How many installments to generate"
                />
                <Input
                  type="date"
                  value={firstDue}
                  max={target.completionDate}
                  onChange={(e) => setFirstDue(e.target.value)}
                  className="w-44"
                  aria-label="First installment due date"
                />
                <Button type="button" variant="secondary" size="sm" onClick={regenerate}>
                  Generate
                </Button>
              </div>
            }
          >
            <TableWrap>
              <thead>
                <tr>
                  <Th className="w-12">#</Th>
                  <Th>Due date</Th>
                  <Th>Amount (₹)</Th>
                  <Th className="text-right">Settled by past payments</Th>
                  <Th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <Td colSpan={5} className="text-center text-muted">
                      No installments yet — set a count and a first due date, then Generate.
                    </Td>
                  </tr>
                ) : (
                  rows.map((row, index) => (
                    <Tr key={index}>
                      <Td className="tabular-nums">{index + 1}</Td>
                      <Td>
                        <Input
                          type="date"
                          value={row.dueDate}
                          max={target.completionDate}
                          onChange={(e) => setRow(index, { dueDate: e.target.value })}
                          aria-label={`Installment ${index + 1} due date`}
                        />
                      </Td>
                      <Td>
                        <Input
                          inputMode="decimal"
                          value={row.amount}
                          placeholder="0.00"
                          onChange={(e) => setRow(index, { amount: e.target.value })}
                          aria-label={`Installment ${index + 1} amount`}
                        />
                      </Td>
                      <Td className="text-right tabular-nums">
                        {settledByCredit[index] > 0 ? (
                          <span className="text-success">{formatPaise(settledByCredit[index])}</span>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td>
                        {rows.length > 1 ? (
                          <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(index)}>
                            Remove
                          </Button>
                        ) : null}
                      </Td>
                    </Tr>
                  ))
                )}
              </tbody>
            </TableWrap>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className={difference === 0 && !outsideRange ? "text-sm text-muted" : "text-sm font-medium text-danger"}>
                {difference === 0
                  ? `${rows.length} installment(s) adding up to ${formatPaise(totalPaise)}`
                  : difference > 0
                    ? `${formatPaise(difference)} still to allocate — the plan must come to ${formatPaise(totalPaise)}`
                    : `${formatPaise(-difference)} over-allocated — the plan must come to ${formatPaise(totalPaise)}`}
                {outsideRange && rows.length > 0
                  ? ` · ${rows.length} row(s) is outside the allowed ${installmentMin}–${installmentMax}`
                  : ""}
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={spreadEvenly}>
                  Spread evenly
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                  Add row
                </Button>
              </div>
            </div>
            {fieldError(state, "rows") ? <p className="mt-2 text-sm text-danger">{fieldError(state, "rows")}</p> : null}

            {carriedLateFeePaise > 0 ? (
              <div className="mt-4">
                <Alert tone="info" title="Late fee already collected is credited in full">
                  {formatPaise(carriedLateFeePaise)} of what was collected was late fee. It was charged against due
                  dates that this change deletes, so it is credited against the new course&rsquo;s fee rather than kept
                  as a penalty on a schedule that no longer exists.
                </Alert>
              </div>
            ) : null}

            {creditLeft > 0 && rows.length > 0 && difference === 0 ? (
              <div className="mt-4">
                <Alert tone="warning" title={`${formatPaise(creditLeft)} more has been collected than the new course charges`}>
                  The new fee is lower than what this student has already paid. The excess is not refunded here — it
                  stays on their record as an unapplied credit and settles the next semester when the promotion run
                  bills it. Refund it separately if that is the intention.
                </Alert>
              </div>
            ) : null}
          </Card>

          <Card title="Why is the course being changed?">
            <Field label="Reason" htmlFor="courseChangeReason" required error={fieldError(state, "reason")}>
              <Textarea
                id="courseChangeReason"
                name="reason"
                rows={3}
                required
                minLength={5}
                placeholder="e.g. Student requested transfer to B.Com after the first term; approved by the principal on 4 Aug."
              />
            </Field>
            <div className="mt-4 flex justify-end">
              <SubmitButton
                pendingLabel="Changing course…"
                disabled={rows.length === 0 || difference !== 0 || outsideRange || totalPaise <= 0}
              >
                Change course &amp; reassign fee
              </SubmitButton>
            </div>
          </Card>
        </>
      )}
    </ActionForm>
  );
}
