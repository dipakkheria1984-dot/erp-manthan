"use client";

import { useState } from "react";
import { ActionForm, Modal, ReasonActionButton, SubmitButton, fieldError } from "@/components/form";
import { Alert, Button, Field, Input, Select, TableWrap, Td, Textarea, Th, Tr } from "@/components/ui";
import { addMonths, fromDateInput, toDateInput } from "@/lib/dates";
import { formatPaise, paiseToRupees, rupeesToPaise, splitPaise } from "@/lib/money";
import {
  addExtraChargeAction,
  assignSemesterFeeAction,
  cancelDiscountAction,
  restoreLateFeeAction,
  changeStudentStatusAction,
  grantDiscountAction,
  toggleBacklogAction,
  unwaiveInstallmentAction,
  waiveInstallmentAction,
} from "../actions";

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "DROPPED_OUT", label: "Dropped-out" },
  { value: "EXPELLED", label: "Expelled" },
  { value: "PASSED", label: "Passed" },
];

export function StatusChangeButton({
  studentId,
  currentStatus,
}: {
  studentId: string;
  currentStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(currentStatus);

  const exiting = status === "DROPPED_OUT" || status === "EXPELLED";
  const reinstating = status === "ACTIVE" && (currentStatus === "DROPPED_OUT" || currentStatus === "EXPELLED");
  const reasonRequired = exiting || reinstating;

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Change status
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Change student status"
        description="Only an Admin can do this. The change is written to the student's status history and the audit trail."
      >
        <ActionForm action={changeStudentStatusAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <input type="hidden" name="studentId" value={studentId} />
              <Field label="New status" htmlFor="status" required error={fieldError(state, "status")}>
                <Select id="status" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value} disabled={option.value === currentStatus}>
                      {option.label}
                      {option.value === currentStatus ? " (current)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>

              {exiting ? (
                <Alert tone="warning" title="Pending fees will be waived">
                  Every unpaid or partly-paid installment, together with any accrued late fee, is cancelled
                  automatically. Amounts already received are <strong>not</strong> refunded — that is a separate manual
                  process.
                </Alert>
              ) : null}
              {reinstating ? (
                <Alert tone="info" title="Waived installments are not restored automatically">
                  After reinstating, review the waived installments on this page and un-waive the ones that should
                  stand.
                </Alert>
              ) : null}
              {status === "PASSED" ? (
                <Alert tone="info">
                  Marking a student Passed is entirely manual — the system never infers course completion.
                </Alert>
              ) : null}

              <Field
                label={reasonRequired ? "Reason" : "Reason (optional)"}
                htmlFor="reason"
                required={reasonRequired}
                error={fieldError(state, "reason")}
              >
                <Textarea id="reason" name="reason" rows={3} required={reasonRequired} minLength={reasonRequired ? 5 : undefined} />
              </Field>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton variant={exiting ? "danger" : "primary"} pendingLabel="Saving…">
                  Update status
                </SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

export function BacklogToggle({ studentId, hasBacklog }: { studentId: string; hasBacklog: boolean }) {
  const [open, setOpen] = useState(false);

  if (hasBacklog) {
    return (
      <ActionForm action={toggleBacklogAction} className="contents">
        <input type="hidden" name="studentId" value={studentId} />
        <SubmitButton variant="secondary" pendingLabel="Clearing…">
          Clear backlog flag
        </SubmitButton>
      </ActionForm>
    );
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Flag backlog
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Flag backlog / reappear"
        description="Informational only — there is no clearance or re-attempt workflow attached to this flag."
      >
        <ActionForm action={toggleBacklogAction} onSuccess={() => setOpen(false)}>
          <input type="hidden" name="studentId" value={studentId} />
          <Field label="Remark" htmlFor="remark">
            <Input id="remark" name="remark" placeholder="e.g. Sem 1 Mathematics" />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton pendingLabel="Saving…">Set flag</SubmitButton>
          </div>
        </ActionForm>
      </Modal>
    </>
  );
}

export function WaiveInstallmentButton({ installmentId }: { installmentId: string }) {
  return (
    <ReasonActionButton
      action={waiveInstallmentAction}
      label="Waive"
      title="Waive installment"
      description="The principal and any accrued late fee are cancelled for this installment."
      confirmLabel="Waive"
      variant="ghost"
      size="sm"
      hidden={{ installmentId }}
    />
  );
}

export function UnwaiveInstallmentButton({ installmentId }: { installmentId: string }) {
  return (
    <ReasonActionButton
      action={unwaiveInstallmentAction}
      label="Restore"
      title="Restore waived installment"
      description="The installment becomes payable again and its late fee is re-assessed against the original due date."
      confirmLabel="Restore"
      variant="secondary"
      size="sm"
      hidden={{ installmentId }}
    />
  );
}

const DISCOUNT_REASONS = [
  { value: "EARLY_PAYMENT", label: "Early payment" },
  { value: "FINANCIAL_HARDSHIP", label: "Financial hardship" },
  { value: "MERIT", label: "Merit" },
  { value: "SIBLING", label: "Sibling concession" },
  { value: "STAFF_WARD", label: "Staff ward" },
  { value: "OTHER", label: "Other" },
];

/**
 * Grant a concession on one installment. The amount can be given either as a
 * percentage of the installment or as a flat figure — institutes quote early
 * payment as a percentage and hardship relief as a round number.
 */
export function GrantDiscountButton({
  studentId,
  installmentId,
  installmentLabel,
  outstandingLabel,
  totalOutstandingLabel,
  unpaidCount,
  trigger,
}: {
  studentId: string;
  /** Absent when the button grants across the whole balance. */
  installmentId?: string;
  installmentLabel?: string;
  outstandingLabel?: string;
  totalOutstandingLabel: string;
  unpaidCount: number;
  trigger: "row" | "header";
}) {
  const [open, setOpen] = useState(false);
  const [basis, setBasis] = useState<"percent" | "amount">("percent");
  const [scope, setScope] = useState<"INSTALLMENT" | "ALL_UNPAID">(installmentId ? "INSTALLMENT" : "ALL_UNPAID");

  const acrossAll = scope === "ALL_UNPAID";
  const target = acrossAll ? `${totalOutstandingLabel} across ${unpaidCount} unpaid installment(s)` : outstandingLabel;

  return (
    <>
      {trigger === "row" ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Discount
        </Button>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Grant discount
        </Button>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={installmentId && !acrossAll ? `Discount ${installmentLabel}` : "Grant a discount"}
        description={`Only an Admin can do this. ${target} is currently outstanding. The assigned fee is not changed — the concession shows as a separate credit on the ledger.`}
      >
        <ActionForm action={grantDiscountAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <input type="hidden" name="studentId" value={studentId} />
              {installmentId ? <input type="hidden" name="installmentId" value={installmentId} /> : null}
              <input type="hidden" name="scope" value={scope} />

              {installmentId ? (
                <Field label="Apply to" htmlFor="discountScope">
                  <Select
                    id="discountScope"
                    value={scope}
                    onChange={(e) => setScope(e.target.value as "INSTALLMENT" | "ALL_UNPAID")}
                  >
                    <option value="INSTALLMENT">This installment only</option>
                    <option value="ALL_UNPAID">All unpaid installments ({unpaidCount})</option>
                  </Select>
                </Field>
              ) : (
                <Alert tone="info">
                  This applies across all {unpaidCount} unpaid installment(s). Paid and waived ones are left alone.
                </Alert>
              )}

              <Field label="Reason" htmlFor="discountReason" required error={fieldError(state, "reason")}>
                <Select id="discountReason" name="reason" defaultValue="EARLY_PAYMENT">
                  {DISCOUNT_REASONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Given as" htmlFor="discountBasis">
                <Select
                  id="discountBasis"
                  value={basis}
                  onChange={(e) => setBasis(e.target.value as "percent" | "amount")}
                >
                  <option value="percent">A percentage of the installment</option>
                  <option value="amount">A fixed amount</option>
                </Select>
              </Field>

              {basis === "percent" ? (
                <Field
                  label="Percentage"
                  htmlFor="discountPercent"
                  required
                  hint={
                    acrossAll
                      ? "Whole number, 1 to 100. Applied to each unpaid installment on its own amount."
                      : "Whole number, 1 to 100. The rupee value it works out to is recorded alongside it."
                  }
                  error={fieldError(state, "percent")}
                >
                  <Input id="discountPercent" name="percent" type="number" min={1} max={100} required />
                </Field>
              ) : (
                <Field
                  label="Amount (₹)"
                  htmlFor="discountAmount"
                  required
                  hint={
                    acrossAll
                      ? `The total concession, spread across the unpaid installments oldest first. Cannot exceed ${totalOutstandingLabel}.`
                      : `Cannot exceed the ${outstandingLabel} still outstanding.`
                  }
                  error={fieldError(state, "amount")}
                >
                  <Input id="discountAmount" name="amount" inputMode="decimal" required />
                </Field>
              )}

              <Field
                label="Justification"
                htmlFor="discountNote"
                required
                hint="Written to the audit trail."
                error={fieldError(state, "note")}
              >
                <Textarea
                  id="discountNote"
                  name="note"
                  rows={3}
                  required
                  minLength={5}
                  placeholder="e.g. Paid the full year up front on 12 Aug; 5% early-payment concession per fee circular 3/2026."
                />
              </Field>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Granting…">Grant discount</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

const EXTRA_CHARGE_KINDS = [
  { value: "ACTIVITY", label: "Extra activity" },
  { value: "EVENT", label: "Event" },
  { value: "PENALTY", label: "Penalty / fine" },
  { value: "OTHER", label: "Other" },
];

/**
 * Bill a student for something outside the admission fee — a field trip, an
 * annual-day charge, a library fine.
 *
 * It becomes an installment on the semester chosen, so it is collected,
 * receipted, chased and reported exactly like the rest of what the family owes.
 * The description is what they see on the ledger and the receipt.
 */
export function AddExtraChargeButton({
  assignments,
  defaultAssignmentId,
}: {
  assignments: { id: string; label: string }[];
  defaultAssignmentId: string;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("ACTIVITY");

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Add charge
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Charge something extra"
        description="For anything outside the fee agreed at admission — an extra activity, an event, a penalty. It is added to the student's dues as its own line, collectible immediately, and a late fee accrues on it if it goes unpaid like any other installment."
      >
        <ActionForm action={addExtraChargeAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <Field
                label="Charge against"
                htmlFor="extraChargeAssignment"
                required
                hint="The semester it is billed under. It has no effect on that semester's own fee."
                error={fieldError(state, "feeAssignmentId")}
              >
                <Select id="extraChargeAssignment" name="feeAssignmentId" defaultValue={defaultAssignmentId} required>
                  {assignments.map((assignment) => (
                    <option key={assignment.id} value={assignment.id}>
                      {assignment.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="What for" htmlFor="extraChargeKind" required error={fieldError(state, "kind")}>
                <Select id="extraChargeKind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {EXTRA_CHARGE_KINDS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Description"
                htmlFor="extraChargeLabel"
                required
                hint="Printed on the ledger, the receipt and the collection screen — write it as the family should read it."
                error={fieldError(state, "label")}
              >
                <Input
                  id="extraChargeLabel"
                  name="label"
                  required
                  minLength={3}
                  maxLength={120}
                  placeholder={
                    kind === "PENALTY" ? "e.g. Library book returned damaged" : "e.g. Industrial visit — Pune, Jan 2027"
                  }
                />
              </Field>

              <Field label="Amount (₹)" htmlFor="extraChargeAmount" required error={fieldError(state, "amount")}>
                <Input id="extraChargeAmount" name="amount" inputMode="decimal" required placeholder="0.00" />
              </Field>

              <Field
                label="Due date"
                htmlFor="extraChargeDueDate"
                required
                hint="A date already past makes it overdue at once, and the late fee slabs apply."
                error={fieldError(state, "dueDate")}
              >
                <Input id="extraChargeDueDate" name="dueDate" type="date" required />
              </Field>

              <Field
                label="Internal note (optional)"
                htmlFor="extraChargeNote"
                hint="Kept in the audit trail, not shown to the family."
                error={fieldError(state, "note")}
              >
                <Textarea id="extraChargeNote" name="note" rows={2} placeholder="e.g. Per hostel warden's report of 12 Jan." />
              </Field>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Charging…">Raise charge</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

/** One editable line of the schedule being laid out. */
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

/** Tuition less scholarship, plus the exam and activity fees — the same sum the server takes. */
function totalOf(
  fees: { tuition?: string; examFee?: string; activityFee?: string } | undefined,
  basis: "PERCENT" | "AMOUNT",
  percent: string,
  amount: string,
): number {
  const tuitionPaise = asPaise(fees?.tuition ?? "0");
  return (
    tuitionPaise -
    scholarshipOf(tuitionPaise, basis, percent, amount) +
    asPaise(fees?.examFee ?? "0") +
    asPaise(fees?.activityFee ?? "0")
  );
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

/** A semester of the student's batch that carries no fee assignment yet. */
export type AssignableSemester = {
  id: string;
  label: string;
  /**
   * Rupee strings prefilled into the form when the semester is chosen. Tuition
   * is the rate locked to the student's enrollment date, offered only on the
   * semester that opens a year the student has not been charged tuition for —
   * tuition is a charge on the year, carried by its first semester.
   */
  tuition: string;
  examFee: string;
  activityFee: string;
  tuitionHint: string;
};

export function AssignFeeButton({
  studentId,
  semesters,
  defaultSemesterId,
  installmentMin,
  installmentMax,
  defaultInstallmentCount,
  defaultFirstDueDate,
  completionDate,
  completionDateLabel,
  variant = "secondary",
}: {
  studentId: string;
  semesters: AssignableSemester[];
  /** The earliest semester the student has reached that carries no fee. */
  defaultSemesterId: string;
  installmentMin: number;
  installmentMax: number;
  defaultInstallmentCount: number;
  defaultFirstDueDate: string;
  /** `yyyy-MM-dd` — no due date may fall after it. */
  completionDate: string;
  completionDateLabel: string;
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const [semesterId, setSemesterId] = useState(defaultSemesterId || (semesters[0]?.id ?? ""));
  const [basis, setBasis] = useState<"PERCENT" | "AMOUNT">("PERCENT");
  const [scholarshipPercent, setScholarshipPercent] = useState("0");
  const [scholarshipAmount, setScholarshipAmount] = useState("");

  const semester = semesters.find((option) => option.id === semesterId) ?? semesters[0];
  const end = fromDateInput(completionDate);

  // The three amounts follow the chosen semester, so switching it re-reads the
  // batch and semester presets instead of leaving the previous one's figures
  // sitting in the fields.
  const [amounts, setAmounts] = useState({
    tuition: semester?.tuition ?? "0.00",
    examFee: semester?.examFee ?? "0.00",
    activityFee: semester?.activityFee ?? "0.00",
  });

  // The generator's inputs. They are not submitted — the rows they produce are,
  // and every one of those can be edited afterwards.
  const [count, setCount] = useState(String(defaultInstallmentCount));
  const [firstDue, setFirstDue] = useState(defaultFirstDueDate);
  const [rows, setRows] = useState<PlanRow[]>(() =>
    spreadOver(
      datesFor(defaultInstallmentCount, defaultFirstDueDate, end),
      totalOf(semesters.find((o) => o.id === (defaultSemesterId || semesters[0]?.id)), "PERCENT", "0", ""),
    ),
  );

  const totalPaise = totalOf({ ...semester, ...amounts }, basis, scholarshipPercent, scholarshipAmount);
  const scholarshipPaise = scholarshipOf(asPaise(amounts.tuition), basis, scholarshipPercent, scholarshipAmount);
  const enteredPaise = rows.reduce((sum, row) => sum + asPaise(row.amount), 0);
  const difference = totalPaise - enteredPaise;
  const outsideRange = rows.length < installmentMin || rows.length > installmentMax;

  function chooseSemester(id: string) {
    setSemesterId(id);
    const chosen = semesters.find((option) => option.id === id);
    if (!chosen) return;
    setAmounts({ tuition: chosen.tuition, examFee: chosen.examFee, activityFee: chosen.activityFee });
    // The dates the user has set are theirs to keep; only the money moves.
    setRows((current) =>
      spreadOver(
        current.map((row) => fromDateInput(row.dueDate)),
        totalOf({ ...chosen }, basis, scholarshipPercent, scholarshipAmount),
      ),
    );
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

  if (semesters.length === 0) return null;

  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)}>
        Assign fee
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Assign a semester's fee"
        description="For a semester this student has never been billed for — most often one who arrived by bulk import and so went through neither approval nor a promotion run. The figures are prefilled from the batch and semester presets; the schedule is generated the same way enrollment and promotion generate one."
        width="lg"
      >
        <ActionForm action={assignSemesterFeeAction} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              <input type="hidden" name="studentId" value={studentId} />
              <input type="hidden" name="scholarshipBasis" value={basis} />
              <input type="hidden" name="rows" value={JSON.stringify(rows)} />

              <Field
                label="Semester"
                htmlFor="assignSemester"
                required
                hint="Only semesters with no fee assigned are listed."
                error={fieldError(state, "semesterId")}
              >
                <Select
                  id="assignSemester"
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
                htmlFor="assignTuition"
                hint={semester?.tuitionHint}
                error={fieldError(state, "lockedTuitionRate")}
              >
                <Input
                  id="assignTuition"
                  name="lockedTuitionRate"
                  inputMode="decimal"
                  value={amounts.tuition}
                  onChange={(e) => setAmounts((v) => ({ ...v, tuition: e.target.value }))}
                />
              </Field>

              <Field label="Scholarship" htmlFor="assignScholarshipBasis">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    id="assignScholarshipBasis"
                    value={basis}
                    onChange={(e) => setBasis(e.target.value as "PERCENT" | "AMOUNT")}
                    className="w-auto"
                  >
                    <option value="PERCENT">Percentage of tuition</option>
                    <option value="AMOUNT">Fixed amount</option>
                  </Select>
                  {basis === "PERCENT" ? (
                    <Input
                      name="scholarshipPercent"
                      inputMode="numeric"
                      value={scholarshipPercent}
                      onChange={(e) => setScholarshipPercent(e.target.value)}
                      className="w-28"
                      aria-label="Scholarship percent"
                    />
                  ) : (
                    <Input
                      name="scholarshipAmount"
                      inputMode="decimal"
                      value={scholarshipAmount}
                      onChange={(e) => setScholarshipAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-40"
                      aria-label="Scholarship amount in rupees"
                    />
                  )}
                  {scholarshipPaise > 0 ? (
                    <span className="text-xs text-muted">− {formatPaise(scholarshipPaise)}</span>
                  ) : null}
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Exam fee (₹)" htmlFor="assignExamFee" error={fieldError(state, "examFee")}>
                  <Input
                    id="assignExamFee"
                    name="examFee"
                    inputMode="decimal"
                    value={amounts.examFee}
                    onChange={(e) => setAmounts((v) => ({ ...v, examFee: e.target.value }))}
                  />
                </Field>
                <Field label="Activity fee (₹)" htmlFor="assignActivityFee" error={fieldError(state, "activityFee")}>
                  <Input
                    id="assignActivityFee"
                    name="activityFee"
                    inputMode="decimal"
                    value={amounts.activityFee}
                    onChange={(e) => setAmounts((v) => ({ ...v, activityFee: e.target.value }))}
                  />
                </Field>
              </div>

              <div className="rounded-md border border-border p-4">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Installments</p>
                    <p className="text-xs text-muted">
                      Between {installmentMin} and {installmentMax}, in date order, every due date on or before{" "}
                      {completionDateLabel}. A date already past makes that installment overdue at once and the late fee
                      slabs apply.
                    </p>
                  </div>
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
                      max={completionDate}
                      onChange={(e) => setFirstDue(e.target.value)}
                      className="w-44"
                      aria-label="First installment due date"
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={regenerate}>
                      Generate
                    </Button>
                  </div>
                </div>

                <TableWrap>
                  <thead>
                    <tr>
                      <Th className="w-12">#</Th>
                      <Th>Due date</Th>
                      <Th>Amount (₹)</Th>
                      <Th className="w-24" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <Td colSpan={4} className="text-center text-muted">
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
                              max={completionDate}
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
                  <span
                    className={`text-sm ${difference === 0 && !outsideRange ? "text-muted" : "text-danger font-medium"}`}
                  >
                    {difference === 0
                      ? `${rows.length} installment(s) adding up to ${formatPaise(totalPaise)}`
                      : difference > 0
                        ? `${formatPaise(difference)} still to allocate — the plan must come to ${formatPaise(totalPaise)}`
                        : `${formatPaise(-difference)} over-allocated — the plan must come to ${formatPaise(totalPaise)}`}
                    {outsideRange ? ` · ${rows.length} row(s) is outside the allowed ${installmentMin}–${installmentMax}` : ""}
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
                {fieldError(state, "rows") ? (
                  <p className="mt-2 text-sm text-danger">{fieldError(state, "rows")}</p>
                ) : null}
              </div>

              <Field
                label="Note (optional)"
                htmlFor="assignNote"
                hint="Kept on the assignment and in the audit trail — say why it was assigned by hand."
                error={fieldError(state, "note")}
              >
                <Textarea
                  id="assignNote"
                  name="note"
                  rows={2}
                  placeholder="e.g. Migrated by bulk import; current year billed by hand."
                />
              </Field>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton pendingLabel="Assigning…" disabled={difference !== 0 || outsideRange || totalPaise <= 0}>
                  Assign fee
                </SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}

export function CancelDiscountButton({ discountId, amountLabel }: { discountId: string; amountLabel: string }) {
  return (
    <ReasonActionButton
      action={cancelDiscountAction}
      label="Cancel"
      title={`Cancel the ${amountLabel} discount`}
      description="The discount is voided, never deleted, and the amount becomes payable again. Any late fee is re-assessed against the original due date."
      confirmLabel="Cancel discount"
      reasonLabel="Why is it being cancelled?"
      variant="ghost"
      size="sm"
      hidden={{ discountId }}
    />
  );
}

export function RestoreLateFeeButton({ installmentId }: { installmentId: string }) {
  return (
    <ReasonActionButton
      action={restoreLateFeeAction}
      label="Restore late fee"
      title="Restore the late fee"
      description="The late fee is re-assessed against the original due date, so the slab that applies is the one the delay actually earned."
      confirmLabel="Restore"
      variant="ghost"
      size="sm"
      hidden={{ installmentId }}
    />
  );
}
