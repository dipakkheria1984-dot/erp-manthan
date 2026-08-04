-- The institute's collection register records some receipts under "Other" —
-- money that arrives by none of the named modes. Bulk receipt imports carry
-- those rows through as-is, so the mode has to exist rather than be folded into
-- Bank Transfer, which would misstate the Fee Collection report.
ALTER TYPE "PaymentMode" ADD VALUE 'OTHER';
