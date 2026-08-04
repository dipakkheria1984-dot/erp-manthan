-- DropIndex
DROP INDEX "Payment_receiptNo_key";

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "receiptSeq" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "Payment_receiptNo_idx" ON "Payment"("receiptNo");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_receiptNo_receiptSeq_key" ON "Payment"("receiptNo", "receiptSeq");
