import { NextResponse } from "next/server";
import { authorizeJobRequest } from "@/lib/job-auth";
import { runNotificationRetryPass } from "@/lib/notification-retry";

/**
 * Scheduled retry of messages the gateway would not take.
 *
 * Two callers, two shapes, matching /api/jobs/reminders:
 *
 * - **POST** with `x-job-secret: $JOB_SECRET` — any external scheduler.
 * - **GET** with `Authorization: Bearer $CRON_SECRET` — Vercel Cron, which
 *   only issues GET and cannot send a custom header. The schedule is in
 *   vercel.json.
 *
 * Runs far more often than the reminder pass — a retry that waits half an hour
 * is no use on a job that fires once a day — but does almost nothing most
 * times: one indexed query that usually comes back empty.
 */

export const maxDuration = 60;
const BUDGET_MS = 50_000;

async function runPass() {
  try {
    const result = await runNotificationRetryPass(new Date(), BUDGET_MS);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[job:notification-retry]", error);
    return NextResponse.json({ ok: false, error: "Notification retry pass failed." }, { status: 500 });
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
