-- Admin-granted concessions on individual installments (early payment,
-- financial hardship and so on).

CREATE TYPE "DiscountReason" AS ENUM ('EARLY_PAYMENT', 'FINANCIAL_HARDSHIP', 'MERIT', 'SIBLING', 'STAFF_WARD', 'OTHER');

-- Cached sum of the active discounts, maintained alongside "lateFeePaise".
ALTER TABLE "Installment" ADD COLUMN "discountPaise" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "Discount" (
    "id" TEXT NOT NULL,
    "installmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "reason" "DiscountReason" NOT NULL,
    "percent" INTEGER,
    "amountPaise" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Discount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Discount_installmentId_idx" ON "Discount"("installmentId");
CREATE INDEX "Discount_studentId_idx" ON "Discount"("studentId");
CREATE INDEX "Discount_grantedAt_idx" ON "Discount"("grantedAt");

ALTER TABLE "Discount" ADD CONSTRAINT "Discount_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Discount" ADD CONSTRAINT "Discount_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Discount" ADD CONSTRAINT "Discount_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Discount" ADD CONSTRAINT "Discount_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
