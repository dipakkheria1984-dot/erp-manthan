"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Badge, Card, Checkbox, Field, FormActions, FormGrid, Input, TableWrap, Td, Th, Tr } from "@/components/ui";
import { toDateInput } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { runPromotionAction } from "./actions";

type StudentRow = {
  id: string;
  studentCode: string;
  fullName: string;
  hasBacklog: boolean;
  outstandingPaise: number;
};

export function PromotionRunner({
  batchId,
  fromSemesterId,
  toSemesterLabel,
  students,
  installmentMin,
  installmentMax,
  completionDate,
}: {
  batchId: string;
  fromSemesterId: string;
  toSemesterLabel: string;
  students: StudentRow[];
  installmentMin: number;
  installmentMax: number;
  completionDate: string;
}) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const includedCount = students.length - excluded.size;

  return (
    <ActionForm action={runPromotionAction}>
      {(state) => (
        <Card
          title={`Preview — promoting to ${toSemesterLabel}`}
          description={`${includedCount} of ${students.length} student(s) will be promoted. Untick a student to exclude them.`}
        >
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="fromSemesterId" value={fromSemesterId} />

          <TableWrap>
            <thead>
              <tr>
                <Th className="w-20">Promote</Th>
                <Th>Student ID</Th>
                <Th>Name</Th>
                <Th className="text-right">Outstanding</Th>
                <Th className="w-28">Backlog</Th>
                <Th>Exclusion reason</Th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => {
                const isExcluded = excluded.has(student.id);
                return (
                  <Tr key={student.id} className={isExcluded ? "opacity-60" : undefined}>
                    <Td>
                      <Checkbox
                        checked={!isExcluded}
                        onChange={() => toggle(student.id)}
                        aria-label={`Promote ${student.studentCode}`}
                      />
                      {/* Only excluded students send a flag; the action treats the rest as included. */}
                      {isExcluded ? <input type="hidden" name={`exclude:${student.id}`} value="on" /> : null}
                    </Td>
                    <Td className="font-mono text-xs">{student.studentCode}</Td>
                    <Td className="font-medium">{student.fullName}</Td>
                    <Td className="text-right tabular-nums">
                      {student.outstandingPaise > 0 ? (
                        <span className="text-danger">{formatPaise(student.outstandingPaise)}</span>
                      ) : (
                        formatPaise(0)
                      )}
                    </Td>
                    <Td>
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox name={`backlog:${student.id}`} defaultChecked={student.hasBacklog} />
                        flag
                      </label>
                    </Td>
                    <Td>
                      {isExcluded ? (
                        <Input name={`reason:${student.id}`} placeholder="Why is this student excluded?" className="py-1 text-xs" />
                      ) : student.hasBacklog ? (
                        <Badge tone="warning">Existing backlog</Badge>
                      ) : null}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableWrap>

          <p className="mt-3 text-xs text-muted">
            The backlog flag is informational only — a failing student is promoted anyway and the flag can be toggled
            off later from their record.
          </p>

          <div className="mt-5 border-t border-border pt-5">
            <FormGrid cols={3}>
              <Field
                label="Installments for the new semester"
                htmlFor="installmentCount"
                required
                hint={`Allowed range ${installmentMin}–${installmentMax}.`}
                error={fieldError(state, "installmentCount")}
              >
                <Input
                  id="installmentCount"
                  name="installmentCount"
                  type="number"
                  min={installmentMin}
                  max={installmentMax}
                  defaultValue={Math.min(2, installmentMax)}
                  required
                />
              </Field>
              <Field
                label="First installment due"
                htmlFor="firstDueDate"
                required
                hint={`On or before ${new Date(completionDate).toLocaleDateString("en-IN")}.`}
                error={fieldError(state, "firstDueDate")}
              >
                <Input id="firstDueDate" name="firstDueDate" type="date" defaultValue={toDateInput(new Date())} required />
              </Field>
              <Field label="Notes" htmlFor="notes" error={fieldError(state, "notes")}>
                <Input id="notes" name="notes" placeholder="Recorded in the audit trail" />
              </Field>
            </FormGrid>

            <FormActions>
              <SubmitButton pendingLabel="Promoting…" disabled={includedCount === 0}>
                Promote {includedCount} student{includedCount === 1 ? "" : "s"}
              </SubmitButton>
            </FormActions>
          </div>
        </Card>
      )}
    </ActionForm>
  );
}
