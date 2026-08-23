/**
 * Triggers one notification retry sweep against a running instance.
 *
 *   npm run job:notification-retry
 *
 * The retry logic lives in src/lib/notification-retry.ts, which is server-only
 * code — it is reached through /api/jobs/notification-retry rather than imported
 * here, so there is exactly one code path whether the sweep is triggered by
 * cron, by a hosted scheduler, or by hand.
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

  const response = await fetch(`${baseUrl}/api/jobs/notification-retry`, {
    method: "POST",
    headers: { "x-job-secret": secret },
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Retry sweep failed (${response.status}): ${JSON.stringify(body)}`);
  }

  console.log(
    `Retry sweep — attempted ${body.attempted}, sent ${body.sent}, failed again ${body.failed}, ` +
      `skipped ${body.skipped}.`,
  );
  if (Number(body.remaining) > 0) {
    console.warn(`${body.remaining} still due — the sweep ran out of time. Run it again to send them sooner.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
