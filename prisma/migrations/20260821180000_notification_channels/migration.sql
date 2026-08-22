-- AlterTable
ALTER TABLE "InstituteConfig" ADD COLUMN     "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "overdueReminderMaxCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "whatsappNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;
