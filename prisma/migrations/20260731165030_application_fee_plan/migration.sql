-- CreateTable
CREATE TABLE "ApplicationInstallment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "seqNo" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApplicationInstallment_applicationId_idx" ON "ApplicationInstallment"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationInstallment_applicationId_seqNo_key" ON "ApplicationInstallment"("applicationId", "seqNo");

-- AddForeignKey
ALTER TABLE "ApplicationInstallment" ADD CONSTRAINT "ApplicationInstallment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
