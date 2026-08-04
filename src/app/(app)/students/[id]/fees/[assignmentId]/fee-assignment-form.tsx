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
import { updateFeeAssignmentAction } from "../../../actions";

export type EditableInstallment = {
  id: string;
  dueDate: string;
  amount: string;
  /** Paid + discounted against this row — the amount it cannot go below. */
  floorPaise: number;
  /** Why the row cannot be removed, or null when it can. */
  lockedReason: string | null;
};

const toPaise = (value: string): number => {
  const cleaned = value.trim().replace(/[,\s₹]/g, "");
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? rupeesToPaise(n) : Number.NaN;
};

const asPaise = (value: string): number => {
  const paise = toPaise(value);
  return Number.isFinite(paise) ? paise : 0;
};

/**
 * Correct an assigned fee after enrollment.
 *
 * The charge is built exactly as it is at enrollment — batch fee less
 * scholarship, plus exam and activity fees — and the installments underneath it
 * have to add up to the result, so the two can never drift apart. Rows that
 * money has already touched are held at their floor and cannot be removed;
 * the server re-checks all of it.
 */
export type ExtraChargeRow = {
  id: string;
  label: string;
  kind: string;
  dueDate: string;
  amountPaise: number;
  status: string;
};

export function FeeAssignmentForm({
  assignmentId,
  initial,
  extras,
  completionDate,
  installmentMin,
  installmentMax,
}: {
  assignmentId: string;
  initial: {
    lockedTuitionRate: string;
    scholarshipBasis: "PERCENT" | "AMOUNT";
    scholarshipPercent: string;
    scholarshipAmount: string;
    examFee: string;
    activityFee: string;
    rows: EditableInstallment[];
  };
  extras: ExtraChargeRow[];
  completionDate: string;
  installmentMin: number;
  installmentMax: number;
}) {
  const [lockedTuitionRate, setLockedTuitionRate] = useState(initial.lockedTuitionRate);
  const [basis, setBasis] = useState<"PERCENT" | "AMOUNT">(initial.scholarshipBasis);
  const [scholarshipPercent, setScholarshipPercent] = useState(initial.scholarshipPercent);
  const [scholarshipAmount, setScholarshipAmount] = useState(initial.scholarshipAmount);
  const [examFee, setExamFee] = useState(initial.examFee);
  const [activityFee, setActivityFee] = useState(initial.activityFee);
  const [rows, setRows] = useState<EditableInstallment[]>(initial.rows);

  const tuitionRatePaise = asPaise(lockedTuitionRate);
  const percent = Number.parseInt(scholarshipPercent || "0", 10);
  const scholarshipPaise =
    basis === "AMOUNT"
      ? Math.min(asPaise(scholarshipAmount), tuitionRatePaise)
      : Math.round((tuitionRatePaise * (Number.isFinite(percent) ? percent : 0)) / 100);
  // The plan covers the semester fee. Extra charges raised later sit on top of
  // it and are not spread across the installments.
  const semesterFeePaise = tuitionRatePaise - scholarshipPaise + asPaise(examFee) + asPaise(activityFee);
  const extrasPaise = extras.reduce((sum, extra) => sum + extra.amountPaise, 0);

  const enteredPaise = rows.reduce((sum, row) => sum + asPaise(row.amount), 0);
  const difference = semesterFeePaise - enteredPaise;
  const end = new Date(completionDate);

  const setRow = (index: number, patch: Partial<EditableInstallment>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const addRow = () => {
    const last = rows[rows.length - 1];
    const nextDue = last?.dueDate ? toDateInput(addMonths(fromDateInput(last.dueDate), 1)) : toDateInput(new Date());
    setRows((current) => [
      ...current,
      { id: "", dueDate: toDateInput(fromDateInput(nextDue) > end ? end : fromDateInput(nextDue)), amount: "", floorPaise: 0, lockedReason: null },
    ]);
  };

  const removeRow = (index: number) => setRows((current) => current.filter((_, i) => i !== index));

  /** Re-spread the corrected semester fee over the rows, keeping their dates. */
  const spreadEvenly = () => {
    if (rows.length === 0 || semesterFeePaise <= 0) return;
    const amounts = splitPaise(semesterFeePaise, rows.length);
    setRows((current) => current.map((row, i) => ({ ...row, amount: paiseToRupees(amounts[i]).toFixed(2) })));
  };

  const belowFloor = rows.filter((row) => row.floorPaise > 0 && asPaise(row.amount) < row.floorPaise);

  return (
    <ActionForm action={updateFeeAssignmentAction} className="space-y-6">
      {(state) => (
        <>
          <input type="hidden" name="assignmentId" value={assignmentId} />
          <input
            type="hidden"
            name="rows"
            value={JSON.stringify(rows.map((row) => ({ id: row.id, dueDate: row.dueDate, amount: row.amount })))}
          />

          <Card
            title="What is charged"
            description="Batch fee less scholarship, plus the semester's exam and activity fees. The installments below must add up to the total."
          >
            <FormGrid cols={3}>
              <Field
                label="Batch fee / tuition (₹)"
                htmlFor="lockedTuitionRate"
                hint="The rate locked for this student at enrollment."
                error={fieldError(state, "lockedTuitionRate")}
              >
                <Input
                  id="lockedTuitionRate"
                  name="lockedTuitionRate"
                  inputMode="decimal"
                  value={lockedTuitionRate}
                  onChange={(e) => setLockedTuitionRate(e.target.value)}
                />
              </Field>
              <Field label="Scholarship given as" htmlFor="scholarshipBasis">
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
                  label="Scholarship (%)"
                  htmlFor="scholarshipPercent"
                  hint="0 — or blank — for none."
                  error={fieldError(state, "scholarshipPercent")}
                >
                  <Input
                    id="scholarshipPercent"
                    name="scholarshipPercent"
                    type="number"
                    min={0}
                    max={100}
                    value={scholarshipPercent}
                    onChange={(e) => setScholarshipPercent(e.target.value)}
                  />
                </Field>
              ) : (
                <Field
                  label="Scholarship (₹)"
                  htmlFor="scholarshipAmount"
                  hint="Cannot exceed the batch fee."
                  error={fieldError(state, "scholarshipAmount")}
                >
                  <Input
                    id="scholarshipAmount"
                    name="scholarshipAmount"
                    inputMode="decimal"
                    value={scholarshipAmount}
                    onChange={(e) => setScholarshipAmount(e.target.value)}
                  />
                </Field>
              )}
              <Field label="Exam fee (₹)" htmlFor="examFee" error={fieldError(state, "examFee")}>
                <Input
                  id="examFee"
                  name="examFee"
                  inputMode="decimal"
                  value={examFee}
                  onChange={(e) => setExamFee(e.target.value)}
                />
              </Field>
              <Field label="Activity fee (₹)" htmlFor="activityFee" error={fieldError(state, "activityFee")}>
                <Input
                  id="activityFee"
                  name="activityFee"
                  inputMode="decimal"
                  value={activityFee}
                  onChange={(e) => setActivityFee(e.target.value)}
                />
              </Field>
            </FormGrid>

            {/* The totals are derived on the server from these same figures. */}
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Scholarship" value={`− ${formatPaise(scholarshipPaise)}`} />
              <StatTile label="Semester fee" value={formatPaise(semesterFeePaise)} hint="The plan must add up to this" />
              <StatTile
                label="Extra charges"
                value={formatPaise(extrasPaise)}
                hint={extras.length > 0 ? `${extras.length} raised separately` : "None raised"}
              />
              <StatTile
                label={difference === 0 ? "Plan matches" : difference > 0 ? "Still to allocate" : "Over-allocated"}
                value={formatPaise(Math.abs(difference))}
                tone={difference === 0 ? "success" : "danger"}
                hint={`${rows.length} installment(s)`}
              />
            </div>
          </Card>

          <Card
            title="Installments"
            description={`Between ${installmentMin} and ${installmentMax} installments, in date order, every due date on or before the batch completion date.`}
            actions={
              <div className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={spreadEvenly}>
                  Spread total evenly
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                  Add installment
                </Button>
              </div>
            }
          >
            <TableWrap>
              <thead>
                <tr>
                  <Th className="w-14">#</Th>
                  <Th>Due date</Th>
                  <Th>Amount (₹)</Th>
                  <Th>Already settled</Th>
                  <Th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <Tr key={row.id || `new-${index}`}>
                    <Td className="tabular-nums">{index + 1}</Td>
                    <Td>
                      <Input
                        type="date"
                        value={row.dueDate}
                        max={toDateInput(end)}
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
                    <Td className="text-xs text-muted">
                      {row.floorPaise > 0 ? `${formatPaise(row.floorPaise)} paid / discounted` : "—"}
                    </Td>
                    <Td>
                      {row.lockedReason ? (
                        <span className="text-xs text-muted">{row.lockedReason}</span>
                      ) : rows.length > 1 ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(index)}>
                          Remove
                        </Button>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>

            {belowFloor.length > 0 ? (
              <div className="mt-4">
                <Alert tone="warning">
                  An installment is below what has already been paid or discounted against it. Raise it to at least that
                  much, or reverse the payment first.
                </Alert>
              </div>
            ) : null}

            {difference !== 0 ? (
              <div className="mt-4">
                <Alert tone="warning">
                  The installments come to {formatPaise(enteredPaise)}; the semester fee above is{" "}
                  {formatPaise(semesterFeePaise)}. Adjust them before saving.
                </Alert>
              </div>
            ) : null}
          </Card>

          {extras.length > 0 ? (
            <Card
              title="Extra charges"
              description="Raised after enrollment — an activity, an event, a fine. They are charges in their own right, not part of the agreed plan, so they are not edited here: cancel one by waiving it on the student's record."
            >
              <TableWrap>
                <thead>
                  <tr>
                    <Th>Charge</Th>
                    <Th>For</Th>
                    <Th>Due date</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {extras.map((extra) => (
                    <Tr key={extra.id}>
                      <Td className="font-medium">{extra.label}</Td>
                      <Td className="text-muted">{extra.kind.charAt(0) + extra.kind.slice(1).toLowerCase()}</Td>
                      <Td className="whitespace-nowrap">{extra.dueDate}</Td>
                      <Td className="text-right tabular-nums">{formatPaise(extra.amountPaise)}</Td>
                      <Td className="text-muted">{extra.status}</Td>
                    </Tr>
                  ))}
                </tbody>
              </TableWrap>
            </Card>
          ) : null}

          <Card title="Why is it being changed?">
            <Field label="Reason" htmlFor="feeAssignmentReason" required error={fieldError(state, "reason")}>
              <Textarea
                id="feeAssignmentReason"
                name="reason"
                rows={3}
                required
                minLength={5}
                placeholder="e.g. Batch fee was typed as 45,000 instead of 54,000 at enrollment."
              />
            </Field>
            <div className="mt-4 flex justify-end">
              <SubmitButton pendingLabel="Saving…" disabled={difference !== 0 || belowFloor.length > 0}>
                Save assigned fee
              </SubmitButton>
            </div>
          </Card>
        </>
      )}
    </ActionForm>
  );
}
