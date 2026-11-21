import "server-only";
import { prisma, type Db } from "@/lib/db";
import type { CampusSyncTopic } from "@/generated/prisma/client";

/**
 * Queuing a student for Manthan Campus.
 *
 * Call this wherever something the attendance application cares about changes:
 * a student is enrolled, their batch or status moves, money is received or a
 * receipt is voided. It is cheap — one upsert — and deliberately forgiving.
 *
 * **It never throws.** A failure to enqueue must not roll back an admission or
 * a receipt: the office's work is the real work, and the copy downstream can
 * catch up. Anything missed is picked up by the next change to that student, or
 * by an Admin resync.
 *
 * The queue coalesces on (student, topic), so twenty edits before the next
 * drain produce one delivery carrying the final state. See the model comment in
 * prisma/schema.prisma for why that is the right shape here.
 */
export async function enqueueCampusSync(
  studentId: string,
  topic: CampusSyncTopic,
  reason: string,
  db: Db = prisma,
): Promise<void> {
  try {
    await db.campusSyncOutbox.upsert({
      where: { studentId_topic: { studentId, topic } },
      create: { studentId, topic, reason, status: "PENDING", nextAttemptAt: new Date() },
      update: {
        // Back to the front of the queue: whatever the previous attempt was
        // doing, the state it was sending is now out of date anyway.
        status: "PENDING",
        reason,
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
      },
    });
  } catch (error) {
    console.error("[campus] failed to enqueue", topic, studentId, error);
  }
}

/** Queue both topics — used when a student is created or their course changes. */
export async function enqueueCampusSyncAll(studentId: string, reason: string, db: Db = prisma): Promise<void> {
  await enqueueCampusSync(studentId, "STUDENT", reason, db);
  await enqueueCampusSync(studentId, "FINANCE", reason, db);
}

/** Queue several students at once — a promotion run, a bulk import. */
export async function enqueueCampusSyncMany(
  studentIds: readonly string[],
  topic: CampusSyncTopic,
  reason: string,
  db: Db = prisma,
): Promise<void> {
  for (const studentId of studentIds) {
    await enqueueCampusSync(studentId, topic, reason, db);
  }
}
