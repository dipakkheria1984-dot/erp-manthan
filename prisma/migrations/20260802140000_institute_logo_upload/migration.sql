-- The logo is now uploaded and stored under UPLOAD_DIR alongside every other
-- upload, rather than being a path the admin types by hand. A path only ever
-- resolved on the machine it was typed on, so it could not survive the app
-- being deployed anywhere else.
ALTER TABLE "Institute" ADD COLUMN "logoStoragePath" TEXT;
ALTER TABLE "Institute" ADD COLUMN "logoFileName" TEXT;
ALTER TABLE "Institute" ADD COLUMN "logoMimeType" TEXT;
ALTER TABLE "Institute" ADD COLUMN "logoSizeBytes" INTEGER;
ALTER TABLE "Institute" ADD COLUMN "logoUpdatedAt" TIMESTAMP(3);

-- Nothing to carry over: the old column held a /public URL, not a stored file,
-- so any institute that had one re-uploads the image itself.
ALTER TABLE "Institute" DROP COLUMN "logoPath";
