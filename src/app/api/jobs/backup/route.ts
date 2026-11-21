import { authorizeJobRequest } from "@/lib/job-auth";
import { BACKUP_FORMAT, archiveFileName, backupStream } from "@/lib/backup/snapshot";

/**
 * The monthly backup, as a download.
 *
 * The office PC pulls from here (see backup-agent/) rather than this app
 * pushing anywhere, which is the same shape as the Tally bridge and for the
 * same reason: no inbound port on the office network, no third-party bucket
 * credentials in the deployment, and the copy ends up on hardware that a
 * failure of this host or its database cannot touch.
 *
 * Authentication is the shared job secret — see src/lib/job-auth.ts. This
 * endpoint returns every row in the database, so it is as sensitive as the
 * database password and the secret should be treated that way.
 *
 *     curl -X POST -H "x-job-secret: $JOB_SECRET" \
 *       https://host/api/jobs/backup -o backup.ndjson.gz
 */

/**
 * The dump streams, so the clock is really about how long the whole database
 * takes to read. 60s is the ceiling on Vercel's Hobby plan and is far more than
 * an institute-sized database needs; the archive is rejected by the agent if a
 * timeout ever does cut one short, because the trailer will be missing.
 */
export const maxDuration = 60;

function archiveResponse(): Response {
  return new Response(backupStream(), {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${archiveFileName()}"`,
      // A backup must never be served from a cache — it would hand back last
      // month's rows under this month's name.
      "cache-control": "no-store",
      "x-backup-format": BACKUP_FORMAT,
    },
  });
}

export async function POST(request: Request) {
  const denied = authorizeJobRequest(request);
  if (denied) return denied;
  return archiveResponse();
}

export async function GET(request: Request) {
  const denied = authorizeJobRequest(request);
  if (denied) return denied;
  return archiveResponse();
}
