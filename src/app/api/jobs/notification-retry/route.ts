import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
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

/** Constant-time compare, so a wrong secret leaks nothing through timing. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
  if (!env.jobSecret) {
    return NextResponse.json({ error: "JOB_SECRET is not configured." }, { status: 503 });
  }
  if (!secretMatches(request.headers.get("x-job-secret"), env.jobSecret)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }
  return runPass();
}

export async function GET(request: Request) {
  if (!env.cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!secretMatches(bearer, env.cronSecret)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }
  return runPass();
}
