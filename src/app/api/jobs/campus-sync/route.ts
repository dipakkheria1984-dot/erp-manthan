import { NextResponse } from "next/server";
import { authorizeJobRequest } from "@/lib/job-auth";
import { drainCampusOutbox, publishInstitute } from "@/lib/campus/publisher";

/**
 * Scheduled drain of the Manthan Campus outbound queue.
 *
 * Two callers, two shapes, matching /api/jobs/reminders:
 *
 * - **POST** with `x-job-secret: $JOB_SECRET` — any external scheduler. This is
 *   how it runs: .github/workflows/campus-sync.yml, every ten minutes.
 * - **GET** with `Authorization: Bearer $CRON_SECRET` — Vercel Cron, which
 *   only issues GET and cannot send a custom header. Not scheduled there:
 *   Vercel Hobby only allows daily crons, and a sub-daily one fails the whole
 *   deployment.
 *
 * Every delivery is idempotent at the far end, so a manual run overlapping the
 * scheduled one cannot double-apply anything.
 */

export const maxDuration = 60;
const BUDGET_MS = 50_000;

async function runPass() {
  try {
    const result = await drainCampusOutbox(200, BUDGET_MS);

    // The institute profile rides along with the daily pass rather than in
    // the queue: one row, no student to key it to, and re-sending the whole
    // thing is what makes a missed push self-heal instead of needing retry
    // machinery of its own.
    const institute = await publishInstitute("scheduled");

    return NextResponse.json({
      ok: true,
      ...result,
      institute: institute.ok ? "sent" : institute.error,
    });
  } catch (error) {
    console.error("[job:campus-sync]", error);
    return NextResponse.json({ ok: false, error: "Campus sync pass failed." }, { status: 500 });
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
