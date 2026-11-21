import { NextResponse } from "next/server";
import { authorizeJobRequest } from "@/lib/job-auth";
import { runReminderPass } from "@/lib/reminders";

/**
 * Scheduled entry point for the fee reminder pass. Two callers, two shapes:
 *
 * - **POST** with `x-job-secret: $JOB_SECRET` — any external scheduler, and
 *   what `npm run job:reminders` uses.
 *
 *       curl -X POST -H "x-job-secret: $JOB_SECRET" https://host/api/jobs/reminders
 *
 * - **GET** with `Authorization: Bearer $CRON_SECRET` — Vercel Cron, which only
 *   issues GET and cannot be given a custom header. The schedule itself lives
 *   in vercel.json.
 *
 * The pass is idempotent either way, so a manual run overlapping the scheduled
 * one cannot double-send a reminder.
 */

/**
 * A pass scans every open installment and sends a paired email + WhatsApp per
 * reminder, so it takes far longer than a page render. 60s is the ceiling on
 * Vercel's Hobby plan; the default 10s would cut a real run short.
 */
export const maxDuration = 60;

/**
 * The same ceiling handed to the pass, so it can stop and record where it got
 * to instead of being killed mid-message with nothing written down.
 */
const BUDGET_MS = maxDuration * 1000;

async function runPass() {
  try {
    const result = await runReminderPass(new Date(), BUDGET_MS);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[job:reminders]", error);
    return NextResponse.json({ ok: false, error: "Reminder pass failed." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = authorizeJobRequest(request);
  if (denied) return denied;
  return runPass();
}

export async function GET(request: Request) {
  const denied = authorizeJobRequest(request);
  if (denied) return denied;
  return runPass();
}
