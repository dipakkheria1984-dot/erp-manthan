import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { buildFinancePayload, buildStudentPayload } from "@/lib/campus/payload";
import { enqueueCampusSync, enqueueCampusSyncAll } from "@/lib/campus/outbox";
import type { CampusSyncTopic } from "@/generated/prisma/client";

/**
 * Delivering queued changes to Manthan Campus.
 *
 * Signed the same way the far end verifies: HMAC-SHA256 over
 * `${timestamp}.${body}`, sent as `x-manthan-signature`, with the timestamp
 * beside it so a captured request cannot be replayed once it ages out. Each
 * delivery also carries an event id, which is what lets the far end recognise a
 * retry and answer it without applying anything twice.
 *
 * Failures back off — a minute, two, four, up to an hour — so an outage at the
 * other end costs a handful of requests rather than a tight retry loop. Nothing
 * is ever dropped: a row stays in the queue until it is delivered or an
 * administrator clears it.
 */

const MAX_ATTEMPTS = 12;
const PATHS: Record<CampusSyncTopic, string> = {
  STUDENT: "/api/erp/webhook/students",
  FINANCE: "/api/erp/webhook/fees",
};

export function campusConfigured(): boolean {
  return env.campusWebhookUrl !== "" && env.campusWebhookSecret !== "";
}

function sign(timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", env.campusWebhookSecret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** Exponential backoff, capped at an hour. */
function nextAttemptAfter(attempts: number): Date {
  const minutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + minutes * 60_000);
}

export type DeliveryResult = { ok: true } | { ok: false; error: string; permanent?: boolean };

async function post(topic: CampusSyncTopic, body: unknown): Promise<DeliveryResult> {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));

  try {
    const response = await fetch(`${env.campusWebhookUrl.replace(/\/$/, "")}${PATHS[topic]}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-manthan-event-id": randomUUID(),
        "x-manthan-timestamp": timestamp,
        "x-manthan-signature": sign(timestamp, raw),
      },
      body: raw,
      // A slow far end must not hold a request open indefinitely; the row stays
      // queued and is tried again.
      signal: AbortSignal.timeout(20_000),
    });

    const detail = (await response.text()).slice(0, 400);

    if (response.ok) {
      /*
       * A 200 does not by itself mean the students were applied. The far end
       * answers 200 for a partial delivery too — some records written, others
       * rejected — and treating that as success marked rows delivered that had
       * never landed, which is how a resync quietly lost a third of a cohort.
       *
       * So the counts are read back. Any failure keeps the whole batch queued;
       * applying is idempotent, so the ones that did land are simply rewritten
       * on the retry.
       */
      let failed = 0;
      try {
        const body = JSON.parse(detail || "{}") as { failed?: number; duplicate?: boolean };
        // A duplicate is a delivery the far end has already applied. Nothing
        // more to do, and nothing to retry.
        if (body.duplicate) return { ok: true };
        failed = typeof body.failed === "number" ? body.failed : 0;
      } catch {
        // Unparseable success response — take the status code at its word.
        return { ok: true };
      }
      if (failed === 0) return { ok: true };
      return { ok: false, error: `Applied with ${failed} failed record(s): ${detail}` };
    }

    /*
     * 422 means the records were understood but could not be applied, which is
     * routinely transient — fees for a student whose own sync has not landed
     * yet is the common case — so it is retried.
     *
     * Other 4xx is this end sending something wrong, and an identical retry
     * will fail identically; recorded as permanent so it surfaces for a person
     * rather than retrying for a day. 429 and 5xx are always worth retrying.
     */
    const permanent =
      response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 422;
    return { ok: false, error: `HTTP ${response.status}: ${detail}`, permanent };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Request failed." };
  }
}

/**
 * How many students travel in one delivery.
 *
 * A student payload is a few hundred bytes; a finance payload carries every
 * fee line and ledger transaction the student has, so it is an order of
 * magnitude larger and travels in smaller groups.
 *
 * Batching is not only about speed. A resync of a whole institute is hundreds
 * of students, and one request each would trip the receiving end's rate limit
 * long before it finished — which is exactly what happened before these
 * existed.
 */
const BATCH_SIZE: Record<CampusSyncTopic, number> = { STUDENT: 100, FINANCE: 20 };

const EVENTS: Record<CampusSyncTopic, string> = {
  STUDENT: "student.upserted",
  FINANCE: "fee.resync",
};

/** Build the payloads for a group of students, dropping any since deleted. */
async function buildBatch(studentIds: readonly string[], topic: CampusSyncTopic) {
  const build = topic === "STUDENT" ? buildStudentPayload : buildFinancePayload;
  const payloads = await Promise.all(studentIds.map((id) => build(id)));
  return payloads.filter((payload): payload is Record<string, unknown> => payload !== null);
}

/** Send one student's current state for one topic, outside the queue. */
export async function deliverNow(studentId: string, topic: CampusSyncTopic): Promise<DeliveryResult> {
  if (!campusConfigured()) {
    return { ok: false, error: "Manthan Campus is not configured on this deployment.", permanent: true };
  }
  const students = await buildBatch([studentId], topic);
  // Deleted since queuing — nothing to send, and nothing to retry.
  if (students.length === 0) return { ok: true };
  return post(topic, { event: EVENTS[topic], students });
}

export type DrainResult = {
  attempted: number;
  delivered: number;
  failed: number;
  skipped: number;
  /** Requests actually made — far fewer than `attempted`, because of batching. */
  requests: number;
  /** True when the budget ran out with rows still due. */
  more: boolean;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Work through the queue, a batch at a time.
 *
 * `budgetMs` bounds the pass so a serverless invocation returns rather than
 * being killed halfway with nothing recorded; whatever is left stays queued for
 * the next run. A batch succeeds or fails as a unit, which is right: the far
 * end applies each student independently and reports per-student failures in
 * its own sync log, so a whole-batch failure means the request itself did not
 * land.
 */
export async function drainCampusOutbox(limit = 200, budgetMs = 50_000): Promise<DrainResult> {
  const startedAt = Date.now();
  const result: DrainResult = { attempted: 0, delivered: 0, failed: 0, skipped: 0, requests: 0, more: false };

  if (!campusConfigured()) {
    result.skipped = await prisma.campusSyncOutbox.count({ where: { status: "PENDING" } });
    return result;
  }

  const due = await prisma.campusSyncOutbox.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });

  for (const topic of ["STUDENT", "FINANCE"] as CampusSyncTopic[]) {
    const rows = due.filter((row) => row.topic === topic);

    for (const group of chunk(rows, BATCH_SIZE[topic])) {
      if (Date.now() - startedAt > budgetMs) {
        result.more = true;
        break;
      }

      result.attempted += group.length;
      result.requests += 1;

      const students = await buildBatch(group.map((row) => row.studentId), topic);
      const outcome =
        students.length === 0
          ? ({ ok: true } as DeliveryResult)
          : await post(topic, { event: EVENTS[topic], students });

      const ids = group.map((row) => row.id);

      if (outcome.ok) {
        await prisma.campusSyncOutbox.updateMany({
          where: { id: { in: ids } },
          data: { status: "DELIVERED", deliveredAt: new Date(), lastError: null },
        });
        result.delivered += group.length;
        continue;
      }

      // `attempts` differs per row, so the give-up decision is made against the
      // highest count in the group and applied to all of them together.
      const attempts = Math.max(...group.map((row) => row.attempts)) + 1;
      const giveUp = outcome.permanent === true || attempts >= MAX_ATTEMPTS;
      await prisma.campusSyncOutbox.updateMany({
        where: { id: { in: ids } },
        data: {
          status: giveUp ? "FAILED" : "PENDING",
          attempts,
          lastError: outcome.error.slice(0, 500),
          nextAttemptAt: nextAttemptAfter(attempts),
        },
      });
      result.failed += group.length;
    }
  }

  if (!result.more) {
    result.more =
      (await prisma.campusSyncOutbox.count({
        where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
      })) > 0;
  }

  return result;
}

/**
 * Nudge the queue after an action, without making the user wait for it.
 *
 * The scheduled pass is the guarantee; this is only so a payment shows up in
 * the student's portal in seconds rather than at the next run. Errors are
 * swallowed for the same reason enqueuing swallows them — the office's work has
 * already succeeded by the time this is called.
 */
export function flushCampusOutboxSoon(): void {
  if (!campusConfigured()) return;
  void drainCampusOutbox(200, 8_000).catch((error) => {
    console.error("[campus] background flush failed", error);
  });
}

/** Queue depth, for the ERP's Campus sync screen. */
export async function campusQueueSummary() {
  const [pending, failed, delivered, lastDelivered] = await Promise.all([
    prisma.campusSyncOutbox.count({ where: { status: "PENDING" } }),
    prisma.campusSyncOutbox.count({ where: { status: "FAILED" } }),
    prisma.campusSyncOutbox.count({ where: { status: "DELIVERED" } }),
    prisma.campusSyncOutbox.findFirst({
      where: { status: "DELIVERED" },
      orderBy: { deliveredAt: "desc" },
      select: { deliveredAt: true },
    }),
  ]);
  return { pending, failed, delivered, lastDeliveredAt: lastDelivered?.deliveredAt ?? null, configured: campusConfigured() };
}

/**
 * Queue a student for Manthan Campus and nudge the queue.
 *
 * The one call sites should use. Queuing is the guarantee — it is durable and
 * survives a restart — and the nudge is only so the change shows up in the
 * student's portal in seconds rather than at the next scheduled pass. Neither
 * half can fail the caller's own work.
 */
export async function notifyCampus(
  studentId: string,
  topic: CampusSyncTopic | "ALL",
  reason: string,
): Promise<void> {
  if (topic === "ALL") {
    await enqueueCampusSyncAll(studentId, reason);
  } else {
    await enqueueCampusSync(studentId, topic, reason);
  }
  flushCampusOutboxSoon();
}

/**
 * Queue a whole cohort — a promotion run, a bulk import.
 *
 * The queue is nudged once at the end rather than per student: a batch of two
 * hundred would otherwise start two hundred overlapping drains.
 */
export async function notifyCampusMany(
  studentIds: readonly string[],
  topic: CampusSyncTopic | "ALL",
  reason: string,
): Promise<void> {
  for (const studentId of studentIds) {
    if (topic === "ALL") {
      await enqueueCampusSyncAll(studentId, reason);
    } else {
      await enqueueCampusSync(studentId, topic, reason);
    }
  }
  flushCampusOutboxSoon();
}
