-- Terms are now kept separately for the admission form and for fee receipts,
-- each with its own version sequence.

CREATE TYPE "TermsDocument" AS ENUM ('ADMISSION', 'RECEIPT');

ALTER TABLE "TermsVersion" ADD COLUMN "document" "TermsDocument" NOT NULL DEFAULT 'ADMISSION';

-- Version numbers used to be globally unique; they now run per document.
DROP INDEX "TermsVersion_version_key";
DROP INDEX "TermsVersion_effectiveFrom_idx";

-- Until now one set of terms was printed on both documents. Give receipts their
-- own copy of that history so nothing a past receipt printed is lost, and so
-- reprints keep showing the text that applied on the payment date.
INSERT INTO "TermsVersion" ("document", "version", "title", "content", "effectiveFrom", "createdById", "createdAt")
SELECT 'RECEIPT', "version", "title", "content", "effectiveFrom", "createdById", "createdAt"
FROM "TermsVersion"
WHERE "document" = 'ADMISSION';

CREATE UNIQUE INDEX "TermsVersion_document_version_key" ON "TermsVersion"("document", "version");
CREATE INDEX "TermsVersion_document_effectiveFrom_idx" ON "TermsVersion"("document", "effectiveFrom");
