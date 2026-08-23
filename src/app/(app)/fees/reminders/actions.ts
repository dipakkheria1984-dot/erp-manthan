"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { ok, runAction, type ActionResult } from "@/lib/errors";
import { retryFailedNotifications } from "@/lib/notification-retry";

/**
 * Send failed messages again, now.
 *
 * With a `logId` it retries that one row; without, every failure that can still
 * be re-sent. Both ignore the automatic schedule — see
 * `retryFailedNotifications` for why waiting would be the wrong answer to
 * somebody who has just fixed the thing that was broken.
 */
export async function retryNotificationsAction(
  _prev?: unknown,
  formData?: FormData,
): Promise<ActionResult<{ sent: number; failed: number }>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);

    const raw = formData?.get("logId");
    const logId = typeof raw === "string" && raw ? raw : null;
    const result = await retryFailedNotifications(logId ? [logId] : undefined);

    const parts: string[] = [];
    if (result.sent > 0) parts.push(`${result.sent} sent`);
    if (result.failed > 0) parts.push(`${result.failed} failed again`);
    if (result.skipped > 0) parts.push(`${result.skipped} skipped, channel switched off`);
    if (result.remaining > 0) parts.push(`${result.remaining} not reached in time`);

    // Nothing attempted and nothing skipped means the list held only rows this
    // screen cannot act on — no recipient on file, or an email that was really
    // an attachment. Saying "0 sent" would read like a failure of the retry
    // rather than what it is.
    const message =
      parts.length > 0
        ? `Retried: ${parts.join("; ")}.`
        : "Nothing here can be re-sent — these failures have no recipient on file, or were emails whose attachment the log does not keep. Send those again from the student's own screen.";

    await recordAudit({
      userId: actor.id,
      action: "notification.retry",
      summary: logId ? `Retried notification ${logId} — ${message}` : `Retried failed notifications — ${message}`,
    });

    revalidatePath("/fees/reminders");
    return ok({ sent: result.sent, failed: result.failed }, message);
  });
}
