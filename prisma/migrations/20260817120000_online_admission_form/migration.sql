-- CreateEnum
CREATE TYPE "ApplicationSource" AS ENUM ('OFFICE', 'ONLINE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'APPLICATION_LINK';
ALTER TYPE "NotificationKind" ADD VALUE 'APPLICATION_ONLINE_RECEIVED';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "applicantSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "portalTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "portalTokenHash" TEXT,
ADD COLUMN     "source" "ApplicationSource" NOT NULL DEFAULT 'OFFICE';

-- AlterTable
ALTER TABLE "InstituteConfig" ADD COLUMN     "onlineAdmissionsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onlineAdmissionsLinkDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "onlineAdmissionsPerHour" INTEGER NOT NULL DEFAULT 3;

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimit_windowStart_idx" ON "RateLimit"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "Application_portalTokenHash_key" ON "Application"("portalTokenHash");

-- CreateIndex
CREATE INDEX "Application_status_source_applicantSubmittedAt_idx" ON "Application"("status", "source", "applicantSubmittedAt");
