-- Write off the late fee on an installment while the principal still stands.
ALTER TABLE "Installment" ADD COLUMN "lateFeeWaived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Installment" ADD COLUMN "lateFeeWaivedAt" TIMESTAMP(3);
ALTER TABLE "Installment" ADD COLUMN "lateFeeWaivedById" TEXT;
ALTER TABLE "Installment" ADD COLUMN "lateFeeWaivedReason" TEXT;

ALTER TABLE "Installment" ADD CONSTRAINT "Installment_lateFeeWaivedById_fkey" FOREIGN KEY ("lateFeeWaivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
