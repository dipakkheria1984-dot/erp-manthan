-- CreateEnum
CREATE TYPE "ExtraChargeKind" AS ENUM ('ACTIVITY', 'EVENT', 'PENALTY', 'OTHER');

-- AlterTable
ALTER TABLE "Installment" ADD COLUMN     "extraChargeKind" "ExtraChargeKind",
ADD COLUMN     "label" TEXT,
ADD COLUMN     "raisedById" TEXT,
ADD COLUMN     "raisedReason" TEXT;

-- AddForeignKey
ALTER TABLE "Installment" ADD CONSTRAINT "Installment_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
