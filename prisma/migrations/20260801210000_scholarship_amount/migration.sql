-- A scholarship may now be quoted as a flat figure instead of a percentage.
-- Existing rows are percentage-based, so both amounts start at zero.
ALTER TABLE "Application" ADD COLUMN "requestedScholarshipPaise" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Application" ADD COLUMN "approvedScholarshipPaise" INTEGER;
