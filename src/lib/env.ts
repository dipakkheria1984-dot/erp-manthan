import "server-only";
import { assertIstProcess } from "@/lib/dates";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  authSecret: required("AUTH_SECRET"),
  sessionTtlHours: optionalInt("SESSION_TTL_HOURS", 12),
  uploadDir: process.env.UPLOAD_DIR ?? "./storage/uploads",
  maxUploadMb: optionalInt("MAX_UPLOAD_MB", 5),
  jobSecret: process.env.JOB_SECRET ?? "",
  // Vercel Cron authenticates with `Authorization: Bearer $CRON_SECRET` and
  // cannot send a custom header, so scheduled runs use this instead of
  // JOB_SECRET. See src/app/api/jobs/reminders/route.ts.
  cronSecret: process.env.CRON_SECRET ?? "",
  // Set by the Vercel Blob integration. Its presence is what switches document
  // storage from the local disk to the blob store — see src/lib/storage.ts.
  blobToken: process.env.BLOB_READ_WRITE_TOKEN ?? "",
  isProduction: process.env.NODE_ENV === "production",
};

// Date arithmetic follows the process time zone, so a server running in UTC
// would put due dates on the wrong side of midnight. Warn at start-up rather
// than let that pass silently.
assertIstProcess();
