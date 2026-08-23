import "server-only";
import { prisma } from "@/lib/db";
import {
  attemptDelivery,
  resolveChannels,
  type Channels,
  type DeliverableLog,
} from "@/lib/notifications";

/**
 * Second and third chances for messages the gateway would not take.
 *
 * A send fails for two quite different reasons and the difference is invisible
 * at the moment it happens. Either the far end is broken for a minute — the
 * WhatsApp panel answering `{"message":"Server Error"}`, SMTP timing out — in
 * which case the same message goes through untouched a little later; or the
 * message itself is wrong, a number that is not on WhatsApp, an address that
 * bounces, and no number of attempts will change that.
 *
 * So a failure is retried a bounded number of times and then stops, and what is
 * still failing at the end is put in front of a person rather than repeated at
 * them. `MAX_DELIVERY_ATTEMPTS` and `RETRY_AFTER_MS` in src/lib/notifications.ts
 * are the two numbers involved.
 *
 * Nothing here composes a message. The retry sends the row exactly as it was
 * written — recipient, subject, body, template variables — which is why those
 * variables are stored on the row in the first place.
 */

/** What a sweep did, for the job response and the audit line. */
export type RetryPassResult = {
  attempted: number;
  sent: number;
  failed: number;
  /** Rows whose channel has since been switched off in Setup. */
  skipped: number;
  /** Still due when the budget ran out; the next sweep picks them up. */
  remaining: number;
};

/** A sweep will not start more than this in one run, however many are due. */
const MAX_PER_PASS = 200;

/** When to stop starting new sends, as a fraction of the caller's wall clock. */
const BUDGET_SPEND = 0.8;

const SELECT = {
  id: true,
  kind: true,
  channel: true,
  recipient: true,
  subject: true,
  body: true,
  templateVariables: true,
  attempts: true,
  retryable: true,
} as const;

/**
 * Re-send a batch of failed rows.
 *
 * A channel switched off in Setup since the message was written is not tried
 * again and is taken off the schedule: the institute has said it does not want
 * that channel used, and an automatic sweep is not the place to overrule it.
 */
async function retryRows(rows: DeliverableLog[], channels: Channels, deadline: number) {
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, row] of rows.entries()) {
    if (Date.now() >= deadline) {
      return { attempted, sent, failed, skipped, remaining: rows.length - index };
    }

    const enabled = row.channel === "EMAIL" ? channels.emailEnabled : channels.whatsappEnabled;
    if (!enabled) {
      skipped += 1;
      await prisma.notificationLog.update({
        where: { id: row.id },
        data: { nextAttemptAt: null },
      });
      continue;
    }

    attempted += 1;
    const result = await attemptDelivery(row, channels);
    if (result.ok) sent += 1;
    else failed += 1;
  }

  return { attempted, sent, failed, skipped, remaining: 0 };
}

/**
 * The scheduled sweep: everything whose wait has elapsed.
 *
 * Due rather than exactly-thirty-minutes-old, so a sweep that does not run —
 * the scheduler was down, the function was cold, the deploy was mid-flight —
 * costs the retry its punctuality and nothing else. Oldest first, so a backlog
 * drains in the order the messages were meant to arrive.
 */
export async function runNotificationRetryPass(
  asOf: Date = new Date(),
  budgetMs = 50_000,
): Promise<RetryPassResult> {
  const deadline = Date.now() + budgetMs * BUDGET_SPEND;

  const due = await prisma.notificationLog.findMany({
    where: { status: "FAILED", nextAttemptAt: { not: null, lte: asOf } },
    select: SELECT,
    orderBy: { nextAttemptAt: "asc" },
    take: MAX_PER_PASS,
  });

  if (due.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0, remaining: 0 };
  }

  return retryRows(due, await resolveChannels(), deadline);
}

/**
 * Send failed messages again now, because somebody asked.
 *
 * Deliberately ignores both the wait and the attempt ceiling. Someone pressing
 * this has usually just put right whatever was wrong — corrected a number,
 * fixed the sender ID, heard from the provider that their outage is over — and
 * being told to come back in half an hour, or that this message has had its
 * three goes, would be answering a question they did not ask. A failure here
 * still counts as an attempt, so a manual retry can be the one that exhausts
 * the automatic schedule.
 *
 * Rows with no recipient on file, and those whose message cannot be rebuilt
 * (an email that was really an attachment), are left alone — see
 * `nextAttemptAfterFailure`.
 */
export async function retryFailedNotifications(
  ids?: string[],
  budgetMs = 50_000,
): Promise<RetryPassResult> {
  const deadline = Date.now() + budgetMs * BUDGET_SPEND;

  const rows = await prisma.notificationLog.findMany({
    where: {
      status: "FAILED",
      retryable: true,
      recipient: { not: "" },
      ...(ids?.length ? { id: { in: ids } } : {}),
    },
    select: SELECT,
    orderBy: { createdAt: "asc" },
    take: MAX_PER_PASS,
  });

  if (rows.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0, remaining: 0 };
  }

  return retryRows(rows, await resolveChannels(), deadline);
}

/** How many failures are waiting on an automatic retry, for the Admin screen. */
export function countAwaitingRetry(asOf: Date = new Date()) {
  return prisma.notificationLog.count({
    where: { status: "FAILED", nextAttemptAt: { not: null, gte: asOf } },
  });
}
