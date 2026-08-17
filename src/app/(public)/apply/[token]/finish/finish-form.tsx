"use client";

import { ActionForm, SubmitButton } from "@/components/form";
import { finishPortalApplicationAction } from "../../actions";

export function FinishForm({ token, ready }: { token: string; ready: boolean }) {
  return (
    <ActionForm action={finishPortalApplicationAction}>
      <input type="hidden" name="token" value={token} />
      <SubmitButton disabled={!ready} pendingLabel="Sending…">
        Send my form to the admissions office
      </SubmitButton>
    </ActionForm>
  );
}
