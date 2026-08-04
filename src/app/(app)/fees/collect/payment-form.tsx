"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Alert, Badge, Field, FormActions, FormGrid, Input, Select, TableWrap, Td, Th, Tr } from "@/components/ui";
import { toDateInput } from "@/lib/dates";
import { formatPaise, paiseToRupees, rupeesToPaise } from "@/lib/money";
import { recordPaymentAction } from "../actions";

/** Already ordered oldest-due-first by the page. */
export type PayableInstallment = {
  id: string;
  label: string;
  dueLabel: string;
  outstandingPaise: number;
  lateFeeOutstandingPaise: number;
};

/** Mirrors the server's FIFO allocation so the collector sees it before saving. */
function allocatePreview(installments: PayableInstallment[], amountPaise: number) {
  let remaining = amountPaise;
  const rows: { installment: PayableInstallment; applied: number }[] = [];
  for (const installment of installments) {
    const applied = Math.min(remaining, installment.outstandingPaise);
    remaining -= applied;
    rows.push({ installment, applied });
  }
  return rows;
}

const toPaise = (value: string): number => {
  const cleaned = value.trim().replace(/,/g, "");
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? rupeesToPaise(n) : Number.NaN;
};

export function PaymentForm({
  studentId,
  installments,
}: {
  studentId: string;
  installments: PayableInstallment[];
}) {
  const totalOutstanding = installments.reduce((sum, row) => sum + row.outstandingPaise, 0);
  const [amount, setAmount] = useState(String(paiseToRupees(totalOutstanding)));
  const [receipt, setReceipt] = useState<string | null>(null);

  const entered = toPaise(amount);
  const valid = Number.isFinite(entered) && entered > 0;

  const covered = allocatePreview(installments, valid ? Math.min(entered, totalOutstanding) : 0).filter(
    (row) => row.applied > 0,
  );
  const excess = valid ? entered - Math.min(entered, totalOutstanding) : 0;

  return (
    <ActionForm
      action={recordPaymentAction}
      onSuccess={(state) => {
        const data = state.ok ? (state.data as { receiptNo: string }) : undefined;
        setReceipt(data?.receiptNo ?? null);
      }}
    >
      {(state) => (
        <>
          {receipt ? (
            <Alert tone="success" title={`Receipt ${receipt} generated`}>
              <a href={`/api/receipts/${receipt}`} target="_blank" rel="noreferrer" className="underline">
                Open the printable receipt
              </a>{" "}
              — it lists every installment the amount was applied to, and the institute&apos;s terms &amp; conditions
              are printed at the bottom.
            </Alert>
          ) : null}

          <input type="hidden" name="studentId" value={studentId} />

          <FormGrid cols={3}>
            <Field
              label="Amount (₹)"
              htmlFor="amountPaise"
              required
              hint={`Applied to the oldest due installment first. Up to ${formatPaise(totalOutstanding)} outstanding in total — one amount can settle several installments.`}
              error={fieldError(state, "amountPaise")}
            >
              <Input
                id="amountPaise"
                name="amountPaise"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </Field>
            <Field label="Payment date" htmlFor="paymentDate" required error={fieldError(state, "paymentDate")}>
              <Input id="paymentDate" name="paymentDate" type="date" defaultValue={toDateInput(new Date())} required />
            </Field>
            <Field label="Mode" htmlFor="mode" required error={fieldError(state, "mode")}>
              <Select id="mode" name="mode" defaultValue="CASH">
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CHEQUE">Cheque</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
            <Field label="Transaction reference" htmlFor="referenceNo" error={fieldError(state, "referenceNo")}>
              <Input id="referenceNo" name="referenceNo" placeholder="UTR / cheque no." />
            </Field>
            <Field label="Remarks" htmlFor="remarks" error={fieldError(state, "remarks")} className="sm:col-span-2">
              <Input id="remarks" name="remarks" />
            </Field>
          </FormGrid>

          {excess > 0 ? (
            <div className="mt-4">
              <Alert tone="warning" title="More than the student owes">
                {formatPaise(excess)} of this amount cannot be allocated — the total outstanding is{" "}
                {formatPaise(totalOutstanding)}. Reduce the amount before recording it.
              </Alert>
            </div>
          ) : null}

          {covered.length > 0 ? (
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium">
                This payment will settle {covered.length === 1 ? "1 installment" : `${covered.length} installments`}
              </p>
              <TableWrap>
                <thead>
                  <tr>
                    <Th>Installment</Th>
                    <Th>Due</Th>
                    <Th className="text-right">Outstanding</Th>
                    <Th className="text-right">Applied</Th>
                    <Th>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {covered.map(({ installment, applied }) => (
                    <Tr key={installment.id}>
                      <Td>{installment.label}</Td>
                      <Td className="whitespace-nowrap">{installment.dueLabel}</Td>
                      <Td className="text-right tabular-nums">{formatPaise(installment.outstandingPaise)}</Td>
                      <Td className="text-right font-medium tabular-nums">{formatPaise(applied)}</Td>
                      <Td>
                        {applied >= installment.outstandingPaise ? (
                          <Badge tone="success">Cleared</Badge>
                        ) : (
                          <Badge tone="warning">
                            {formatPaise(installment.outstandingPaise - applied)} left
                          </Badge>
                        )}
                        {installment.lateFeeOutstandingPaise > 0 ? (
                          <p className="text-xs text-muted">
                            incl. {formatPaise(Math.min(applied, installment.lateFeeOutstandingPaise))} late fee,
                            settled first
                          </p>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
          ) : null}

          <FormActions>
            <SubmitButton disabled={!valid || excess > 0} pendingLabel="Recording…">
              Record payment
            </SubmitButton>
          </FormActions>
        </>
      )}
    </ActionForm>
  );
}
