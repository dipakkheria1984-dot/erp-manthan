-- AlterTable
ALTER TABLE "Discount" ADD COLUMN     "lateFeeSourceInstallmentId" TEXT;

-- AddForeignKey
ALTER TABLE "Discount" ADD CONSTRAINT "Discount_lateFeeSourceInstallmentId_fkey" FOREIGN KEY ("lateFeeSourceInstallmentId") REFERENCES "Installment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
