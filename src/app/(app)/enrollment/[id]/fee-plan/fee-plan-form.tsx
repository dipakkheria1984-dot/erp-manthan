"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/form";
import { Alert, Button, Card, Field, Input, StatTile, TableWrap, Td, Th, Tr } from "@/components/ui";
import { addMonths, fromDateInput, toDateInput } from "@/lib/dates";
import { formatPaise, paiseToRupees, rupeesToPaise, splitPaise } from "@/lib/money";
import { saveFeePlanAction } from "../../actions";

export type PlanRow = { dueDate: string; amount: string };

const amountPaise = (value: string): number => {
  const cleaned = value.trim().replace(/,/g, "");
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? rupeesToPaise(n) : Number.NaN;
};

export type FeeBreakdown = {
  lockedRatePaise: number;
  examFeePaise: number;
  activityFeePaise: number;
  scholarshipPercent: number;
  scholarshipAmountPaise: number;
  totalPayablePaise: number;
};

export function FeePlanForm({
  applicationId,
  initialRows,
  breakdown,
  registrationPaidPaise,
  minFirstInstallmentPaise,
  completionDate,
  installmentMin,
  installmentMax,
}: {
  applicationId: string;
  initialRows: PlanRow[];
  breakdown: FeeBreakdown;
  registrationPaidPaise: number;
  minFirstInstallmentPaise: number;
  completionDate: string;
  installmentMin: number;
  installmentMax: number;
}) {
  const totalPayablePaise = breakdown.totalPayablePaise;
  const [rows, setRows] = useState<PlanRow[]>(
    initialRows.length > 0 ? initialRows : [{ dueDate: toDateInput(new Date()), amount: "" }],
  );
  const [count, setCount] = useState(String(Math.min(4, installmentMax)));
  const [firstDue, setFirstDue] = useState(toDateInput(new Date()));

  const enteredPaise = rows.reduce((sum, row) => {
    const paise = amountPaise(row.amount);
    return sum + (Number.isFinite(paise) ? paise : 0);
  }, 0);
  const difference = totalPayablePaise - enteredPaise;
  const end = new Date(completionDate);

  const setRow = (index: number, patch: Partial<PlanRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const addRow = () => {
    const last = rows[rows.length - 1];
    const nextDue = last?.dueDate ? toDateInput(addMonths(fromDateInput(last.dueDate), 1)) : toDateInput(new Date());
    setRows((current) => [...current, { dueDate: nextDue, amount: "" }]);
  };

  const removeRow = (index: number) => setRows((current) => current.filter((_, i) => i !== index));

  // Convenience only — every generated row stays editable before saving.
  const generate = () => {
    const n = Number.parseInt(count, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const start = fromDateInput(firstDue);
    if (Number.isNaN(start.getTime())) return;
    const amounts = splitPaise(totalPayablePaise, n);
    setRows(
      amounts.map((paise, i) => {
        const due = addMonths(start, i);
        return {
          dueDate: toDateInput(due > end ? end : due),
          amount: paiseToRupees(paise).toFixed(2),
        };
      }),
    );
  };

  return (
    <ActionForm action={saveFeePlanAction} className="space-y-4">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="rows" value={JSON.stringify(rows)} />

      <Card title="Fee assignable" description="Batch fee + exam fee + activity fee − scholarship.">
        <TableWrap>
          <tbody>
            <Tr>
              <Td>Batch fee (tuition, locked at enrollment)</Td>
              <Td className="text-right tabular-nums">{formatPaise(breakdown.lockedRatePaise)}</Td>
            </Tr>
            <Tr>
              <Td>Exam fee — semester 1</Td>
              <Td className="text-right tabular-nums">
                {breakdown.examFeePaise > 0 ? (
                  formatPaise(breakdown.examFeePaise)
                ) : (
                  <span className="text-danger">{formatPaise(0)}</span>
                )}
              </Td>
            </Tr>
            <Tr>
              <Td>Activity fee — semester 1</Td>
              <Td className="text-right tabular-nums">
                {breakdown.activityFeePaise > 0 ? (
                  formatPaise(breakdown.activityFeePaise)
                ) : (
                  <span className="text-danger">{formatPaise(0)}</span>
                )}
              </Td>
            </Tr>
            <Tr>
              <Td>
                Scholarship{breakdown.scholarshipPercent > 0 ? ` (${breakdown.scholarshipPercent}% of the batch fee)` : " (fixed amount)"}
              </Td>
              <Td className="text-right tabular-nums">−{formatPaise(breakdown.scholarshipAmountPaise)}</Td>
            </Tr>
            <Tr>
              <Td className="font-semibold">Total fee assignable</Td>
              <Td className="text-right font-semibold tabular-nums">{formatPaise(totalPayablePaise)}</Td>
            </Tr>
          </tbody>
        </TableWrap>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatTile
          label="Registration fee collected"
          value={formatPaise(registrationPaidPaise)}
          hint="Part of the total — applied to installment 1"
        />
        <StatTile
          label={difference === 0 ? "Plan matches" : difference > 0 ? "Still to allocate" : "Over-allocated"}
          value={formatPaise(Math.abs(difference))}
          tone={difference === 0 ? "success" : "danger"}
          hint={`${rows.length} installment(s) entered`}
        />
      </div>

      <Card
        title="Installments"
        description={`Between ${installmentMin} and ${installmentMax} installments. Every due date must fall on or before the batch completion date, and the amounts must add up to the total fee.`}
        actions={
          <Button type="button" variant="secondary" size="sm" onClick={addRow}>
            Add installment
          </Button>
        }
      >
        <div className="mb-4 grid gap-3 rounded-md border border-border bg-background p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Number of installments" htmlFor="planCount">
            <Input
              id="planCount"
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              min={installmentMin}
              max={installmentMax}
              type="number"
            />
          </Field>
          <Field label="First due date" htmlFor="planFirstDue">
            <Input id="planFirstDue" type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
          </Field>
          <Button type="button" variant="secondary" onClick={generate}>
            Fill monthly plan
          </Button>
        </div>

        <TableWrap>
          <thead>
            <tr>
              <Th className="w-16">#</Th>
              <Th>Due date</Th>
              <Th>Amount (₹)</Th>
              <Th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <Tr key={index}>
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
                <Td>
                  {rows.length > 1 ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(index)}>
                      Remove
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableWrap>

        {minFirstInstallmentPaise > 0 ? (
          <p className="mt-3 text-xs text-muted">
            Installment 1 must be at least {formatPaise(minFirstInstallmentPaise)} — the registration fee collected at
            enrollment is applied to it.
          </p>
        ) : null}

        {difference !== 0 ? (
          <div className="mt-4">
            <Alert tone="warning">
              The installments come to {formatPaise(enteredPaise)}; the fee for this batch is{" "}
              {formatPaise(totalPayablePaise)}. Adjust the amounts before saving.
            </Alert>
          </div>
        ) : null}

        <div className="mt-4 flex justify-end">
          <SubmitButton pendingLabel="Saving…">Save fee plan</SubmitButton>
        </div>
      </Card>
    </ActionForm>
  );
}
