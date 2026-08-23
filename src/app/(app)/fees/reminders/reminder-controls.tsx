"use client";

import { useActionState } from "react";
import { ActionForm, SubmitButton, emptyFormState } from "@/components/form";
import { recalculateLateFeesAction, runRemindersAction } from "../actions";
import { retryNotificationsAction } from "./actions";

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

/** Retry every failure that can still be re-sent, without waiting for the sweep. */
export function RetryAllButton() {
  return (
    <ActionForm action={retryNotificationsAction} className="contents">
      <SubmitButton variant="secondary" size="sm" pendingLabel="Retrying…">
        Retry all now
      </SubmitButton>
    </ActionForm>
  );
}

/**
 * Retry one row.
 *
 * Its own form rather than an `ActionForm`, because that renders a full-width
 * banner for the result and this one lives in a table cell. A retry that works
 * takes the row off the list anyway, so the only outcome worth showing here is
 * the message coming back refused a second time.
 */
export function RetryOneButton({ logId }: { logId: string }) {
  const [state, formAction] = useActionState(retryNotificationsAction, emptyFormState);

  return (
    <form action={formAction} className="whitespace-nowrap">
      <input type="hidden" name="logId" value={logId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Sending…">
        Retry now
      </SubmitButton>
      {state && !state.ok ? <p className="mt-1 text-xs text-danger">{state.error}</p> : null}
    </form>
  );
}
