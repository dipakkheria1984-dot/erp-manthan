-- CreateEnum
CREATE TYPE "TallyCreditMode" AS ENUM ('FIXED', 'STUDENT');

-- CreateEnum
CREATE TYPE "TallySyncAction" AS ENUM ('CREATE', 'CANCEL');

-- CreateEnum
CREATE TYPE "TallySyncStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SYNCED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "TallyConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "companyName" TEXT,
    "voucherTypeName" TEXT NOT NULL DEFAULT 'Receipt',
    "syncFrom" TIMESTAMP(3),
    "ledgerUpi" TEXT,
    "ledgerCard" TEXT,
    "ledgerBankTransfer" TEXT,
    "ledgerCheque" TEXT,
    "ledgerOther" TEXT,
    "creditMode" "TallyCreditMode" NOT NULL DEFAULT 'FIXED',
    "feeLedger" TEXT NOT NULL DEFAULT 'Fees Received',
    "registrationLedger" TEXT NOT NULL DEFAULT 'Registration Fees Received',
    "lateFeeLedger" TEXT,
    "studentLedgerGroup" TEXT NOT NULL DEFAULT 'Sundry Debtors',
    "sendBankAllocations" BOOLEAN NOT NULL DEFAULT false,
    "bridgeLastSeenAt" TIMESTAMP(3),
    "bridgeTallyOnline" BOOLEAN,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TallyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallySyncOutbox" (
    "id" TEXT NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "action" "TallySyncAction" NOT NULL,
    "status" "TallySyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedUntil" TIMESTAMP(3),
    "tallyMasterId" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TallySyncOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TallyLedger" (
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TallyLedger_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "TallySyncOutbox_status_nextAttemptAt_idx" ON "TallySyncOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "TallySyncOutbox_receiptNo_action_key" ON "TallySyncOutbox"("receiptNo", "action");
