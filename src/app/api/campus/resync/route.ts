import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { campusConfigured, drainCampusOutbox } from "@/lib/campus/publisher";
import { enqueueCampusSyncAll } from "@/lib/campus/outbox";
import type { Prisma } from "@/generated/prisma/client";

/**
 * POST /api/campus/resync — Manthan Campus asking to be sent data again.
 *
 * Deliberately a *push* request rather than a pull endpoint: the campus asks,
 * and this system replies by queuing the students and delivering them through
 * the same signed webhooks everything else goes through. One code path builds
 * every payload, so a resync cannot drift from a live update, and the far end
 * needs no second parser.
 *
 * Scopes:
 *   {"scope":"student","erpStudentId":"..."}   one student
 *   {"scope":"batch","batchCode":"BBA26A"}     every student in a batch
 *   {"scope":"all"}                            every active student
 */

export const maxDuration = 60;

function keyMatches(provided: string | null): boolean {
  if (!provided || !env.campusApiKey) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(env.campusApiKey);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const bodySchema = z.union([
  z.object({ scope: z.literal("student"), erpStudentId: z.string().trim().min(1) }),
  z.object({ scope: z.literal("batch"), batchCode: z.string().trim().min(1) }),
  z.object({ scope: z.literal("all") }),
]);

export async function POST(request: Request) {
  if (!env.campusApiKey) {
    return NextResponse.json({ error: "CAMPUS_API_KEY is not configured." }, { status: 503 });
  }
  if (!keyMatches(request.headers.get("x-campus-api-key"))) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }
  if (!campusConfigured()) {
    return NextResponse.json(
      { error: "This system has no Manthan Campus endpoint configured, so it cannot deliver." },
      { status: 503 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected a scope of student, batch or all." }, { status: 400 });
  }

  const where: Prisma.StudentWhereInput =
    parsed.data.scope === "student"
      ? { id: parsed.data.erpStudentId }
      : parsed.data.scope === "batch"
        ? { batch: { code: parsed.data.batchCode } }
        // A resync of "everything" means everyone still on the roll. Students
        // who left keep whatever the campus already holds about them.
        : { status: { in: ["ACTIVE", "PASSED"] } };

  const students = await prisma.student.findMany({ where, select: { id: true } });
  if (students.length === 0) {
    return NextResponse.json({ ok: true, queued: 0, message: "No students matched." });
  }

  for (const student of students) {
    await enqueueCampusSyncAll(student.id, `campus.resync:${parsed.data.scope}`);
  }

  // Deliver what fits in this request; the scheduled pass picks up the rest.
  const drained = await drainCampusOutbox(200, 45_000);

  return NextResponse.json({ ok: true, queued: students.length, ...drained });
}
