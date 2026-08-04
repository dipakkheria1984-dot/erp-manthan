"use client";

import { ActionForm, SubmitButton } from "@/components/form";
import { recalculateLateFeesAction, runRemindersAction } from "../actions";

export function RecalculateButton() {
  return (
    <ActionForm action={recalculateLateFeesAction} className="contents">
      <SubmitButton variant="secondary" pendingLabel="Recalculating…">
        Recalculate late fees
      </SubmitButton>
    </ActionForm>
  );
}

export function RunRemindersButton() {
  return (
    <ActionForm action={runRemindersAction} className="contents">
      <SubmitButton pendingLabel="Sending…">Run reminder pass now</SubmitButton>
    </ActionForm>
  );
}
