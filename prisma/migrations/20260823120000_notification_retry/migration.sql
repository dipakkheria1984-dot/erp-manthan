-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "retryable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "templateVariables" TEXT[];

-- Rows written before this migration were each attempted exactly once, and none
-- of them is owed an automatic retry: their thirty minutes went by long ago.
-- Left at zero they would read as "never tried" on the failures list.
UPDATE "NotificationLog" SET "attempts" = 1, "lastAttemptAt" = COALESCE("sentAt", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_status_nextAttemptAt_idx" ON "NotificationLog"("status", "nextAttemptAt");
