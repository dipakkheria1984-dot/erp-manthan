-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "claimedPaymentAt" TIMESTAMP(3),
ADD COLUMN     "claimedPaymentPaise" INTEGER,
ADD COLUMN     "claimedPaymentReference" TEXT,
ADD COLUMN     "claimedPaymentSettledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InstituteConfig" ADD COLUMN     "registrationPaymentNote" TEXT,
ADD COLUMN     "registrationPaymentUrl" TEXT;
