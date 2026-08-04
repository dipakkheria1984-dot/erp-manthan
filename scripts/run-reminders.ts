/**
 * Triggers one fee reminder pass against a running instance.
 *
 *   npm run job:reminders
 *
 * The reminder logic itself lives in src/lib/reminders.ts, which is server-only
 * code — it is reached through /api/jobs/reminders rather than imported here, so
 * there is exactly one code path whether the pass is triggered by cron, by a
 * hosted scheduler, or by hand.
 *
 * Set APP_URL when the app is not on http://localhost:3000.
 */
import "dotenv/config";

const baseUrl = process.env.APP_URL ?? "http://localhost:3000";
const secret = process.env.JOB_SECRET;

async function main() {
  if (!secret) {
    throw new Error("JOB_SECRET is not set. Add it to .env.");
  }

  const response = await fetch(`${baseUrl}/api/jobs/reminders`, {
    method: "POST",
    headers: { "x-job-secret": secret },
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Reminder pass failed (${response.status}): ${JSON.stringify(body)}`);
  }

  console.log(
    `Reminder pass complete — scanned ${body.scanned}, pre-due ${body.preDueSent}, overdue ${body.overdueSent}, failures ${body.failures}.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
