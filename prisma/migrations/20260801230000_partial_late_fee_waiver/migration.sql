-- Allow part of an accrued late fee to be written off, not just all of it.
ALTER TABLE "Installment" ADD COLUMN "lateFeeWaivedPaise" INTEGER NOT NULL DEFAULT 0;
