-- CreateEnum
CREATE TYPE "CampusSyncTopic" AS ENUM ('STUDENT', 'FINANCE');

-- CreateEnum
CREATE TYPE "CampusSyncStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "CampusSyncOutbox" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "topic" "CampusSyncTopic" NOT NULL,
    "status" "CampusSyncStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampusSyncOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampusSyncOutbox_status_nextAttemptAt_idx" ON "CampusSyncOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampusSyncOutbox_studentId_topic_key" ON "CampusSyncOutbox"("studentId", "topic");

-- AddForeignKey
ALTER TABLE "CampusSyncOutbox" ADD CONSTRAINT "CampusSyncOutbox_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
