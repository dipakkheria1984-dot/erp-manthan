-- A student may change course after enrollment. The new course brings its own
-- fee: the old assignments are deleted and a fresh one is written, while the
-- payments are re-applied to the new schedule. Because the old structure is
-- deleted, this table is the record of it.

-- CreateTable
CREATE TABLE "CourseChange" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedById" TEXT,
    "reason" TEXT NOT NULL,
    "fromCourseId" TEXT NOT NULL,
    "fromBatchId" TEXT NOT NULL,
    "fromSemesterNumber" INTEGER,
    "toCourseId" TEXT NOT NULL,
    "toBatchId" TEXT NOT NULL,
    "toSemesterNumber" INTEGER NOT NULL,
    "scrappedAssignmentCount" INTEGER NOT NULL DEFAULT 0,
    "scrappedInstallmentCount" INTEGER NOT NULL DEFAULT 0,
    "scrappedTotalPayablePaise" INTEGER NOT NULL DEFAULT 0,
    "scrappedDiscountPaise" INTEGER NOT NULL DEFAULT 0,
    "scrappedSnapshot" JSONB,
    "carriedPaidPaise" INTEGER NOT NULL DEFAULT 0,
    "releasedLateFeePaise" INTEGER NOT NULL DEFAULT 0,
    "unallocatedPaise" INTEGER NOT NULL DEFAULT 0,
    "newTotalPayablePaise" INTEGER NOT NULL DEFAULT 0,
    "newInstallmentCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CourseChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseChange_studentId_changedAt_idx" ON "CourseChange"("studentId", "changedAt");

-- CreateIndex
CREATE INDEX "CourseChange_changedAt_idx" ON "CourseChange"("changedAt");

-- AddForeignKey
ALTER TABLE "CourseChange" ADD CONSTRAINT "CourseChange_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseChange" ADD CONSTRAINT "CourseChange_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseChange" ADD CONSTRAINT "CourseChange_fromCourseId_fkey" FOREIGN KEY ("fromCourseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseChange" ADD CONSTRAINT "CourseChange_toCourseId_fkey" FOREIGN KEY ("toCourseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseChange" ADD CONSTRAINT "CourseChange_fromBatchId_fkey" FOREIGN KEY ("fromBatchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseChange" ADD CONSTRAINT "CourseChange_toBatchId_fkey" FOREIGN KEY ("toBatchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
