-- AlterTable
ALTER TABLE "InstituteConfig" ADD COLUMN     "paymentQrFileName" TEXT,
ADD COLUMN     "paymentQrMimeType" TEXT,
ADD COLUMN     "paymentQrSizeBytes" INTEGER,
ADD COLUMN     "paymentQrStoragePath" TEXT,
ADD COLUMN     "paymentQrUpdatedAt" TIMESTAMP(3);
