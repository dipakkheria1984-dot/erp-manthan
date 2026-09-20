import "server-only";
import { prisma, type Db } from "@/lib/db";
import type { TallyConfig, TallySyncOutbox } from "@/generated/prisma/client";
import {
  buildCancelVoucherXml,
  buildLedgerMasterXml,
  buildReceiptVoucherXml,
  debitLedgerFor,
  isNonCash,
  ledgerAlreadyExists,
  MODE_LABELS,
  parseTallyResponse,
  studentLedgerNeeded,
  type ReceiptForTally,
  type TallyRequest,
} from "@/lib/tally/voucher";

/**
 * Tally Prime connector — the ERP half.
 *
 * Tally runs on a PC in the office and listens on localhost:9000; this app runs
 * in the cloud and cannot reach that port. So the flow is *pulled*: a small
 * bridge on the Tally PC (tally-bridge/ at the repo root) asks
 * /api/tally/pull for work, posts each voucher to Tally, and reports Tally's
 * answer to /api/tally/ack. Nothing here ever needs an inbound port opened on
 * the office network.
 *
 * Only non-cash receipts travel. Cash is counted into Tally from the cash book
 * as it always was; UPI, card, transfer, cheque and "other" are the ones whose
 * bank side has to reconcile, and they are the ones this posts.
 */

const MAX_ATTEMPTS = 10;
/** How long the bridge has to acknowledge before a row may be handed out again. */
const LEASE_MS = 5 * 60_000;

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG: Omit<TallyConfig, "updatedAt"> = {
  id: 1,
  enabled: false,
  companyName: null,
  voucherTypeName: "Receipt",
  syncFrom: null,
  ledgerUpi: null,
  ledgerCard: null,
  ledgerBankTransfer: null,
  ledgerCheque: null,
  ledgerOther: null,
  creditMode: "FIXED",
  feeLedger: "Fees Received",
  registrationLedger: "Registration Fees Received",
  lateFeeLedger: null,
  studentLedgerGroup: "Sundry Debtors",
  sendBankAllocations: false,
  bridgeLastSeenAt: null,
  bridgeTallyOnline: null,
};

export async function getTallyConfig(db: Db = prisma): Promise<Omit<TallyConfig, "updatedAt">> {
  return (await db.tallyConfig.findUnique({ where: { id: 1 } })) ?? DEFAULT_CONFIG;
}

/* -------------------------------------------------------------------------- */
/* Queuing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Queue a freshly saved receipt for Tally, if it should go.
 *
 * Call it after the receipt's transaction commits, with the receipt number.
 * It reads the receipt itself to decide — so call sites need not know the
 * rules — and it **never throws**: a hiccup here must not turn a collected fee
 * into an error on screen. Anything it misses, the sweep in `leaseTallyJobs`
 * picks up on the bridge's next poll.
 */
export async function enqueueTallyReceipt(receiptNo: string): Promise<void> {
  try {
    const config = await getTallyConfig();
    if (!config.enabled || !config.syncFrom) return;

    const line = await prisma.payment.findFirst({
      where: { receiptNo, status: "ACTIVE" },
      select: { mode: true, paymentDate: true },
    });
    if (!line || !isNonCash(line.mode)) return;
    if (line.paymentDate < config.syncFrom) return;

    await prisma.tallySyncOutbox.createMany({
      data: [{ receiptNo, action: "CREATE" }],
      skipDuplicates: true,
    });
  } catch (error) {
    console.error("[tally] failed to enqueue receipt", receiptNo, error);
  }
}

export async function enqueueTallyReceipts(receiptNos: readonly string[]): Promise<void> {
  for (const receiptNo of receiptNos) await enqueueTallyReceipt(receiptNo);
}

/**
 * A receipt was voided in the ERP.
 *
 * If its voucher never reached Tally, there is nothing to cancel there: the
 * pending CREATE is simply skipped. If it did (or might have — it is with the
 * bridge right now) a CANCEL is queued, and handed out only once the CREATE
 * has landed. Never throws, for the same reason as above.
 */
export async function enqueueTallyCancellation(receiptNo: string): Promise<void> {
  try {
    // Only a row that has never been handed to the bridge is certainly absent
    // from Tally. One that has — even if no answer came back — may have landed,
    // and must be cancelled there rather than quietly forgotten here.
    const skipped = await prisma.tallySyncOutbox.updateMany({
      where: {
        receiptNo,
        action: "CREATE",
        status: { in: ["PENDING", "FAILED"] },
        attempts: 0,
        leasedUntil: null,
      },
      data: {
        status: "SKIPPED",
        lastError: "Cancelled in the ERP before it reached Tally.",
        leasedUntil: null,
      },
    });
    if (skipped.count > 0) return;

    const create = await prisma.tallySyncOutbox.findUnique({
      where: { receiptNo_action: { receiptNo, action: "CREATE" } },
      select: { status: true },
    });
    if (!create || create.status === "SKIPPED") return;

    await prisma.tallySyncOutbox.createMany({
      data: [{ receiptNo, action: "CANCEL" }],
      skipDuplicates: true,
    });
  } catch (error) {
    console.error("[tally] failed to enqueue cancellation", receiptNo, error);
  }
}

/**
 * Queue whatever the call sites missed.
 *
 * Two gaps: a non-cash receipt with no CREATE row (enqueue failed, or it came
 * in by a path that does not call it), and a voided receipt whose voucher is in
 * Tally with no CANCEL row. Cheap enough to run on every poll, and it is what
 * makes the queue complete rather than best-effort.
 */
async function sweepMissed(config: Omit<TallyConfig, "updatedAt">): Promise<number> {
  if (!config.syncFrom) return 0;

  const missingCreates = await prisma.$queryRaw<{ receiptNo: string }[]>`
    SELECT DISTINCT p."receiptNo"
    FROM "Payment" p
    WHERE p."status" = 'ACTIVE'
      AND p."mode" <> 'CASH'
      AND p."paymentDate" >= ${config.syncFrom}
      AND NOT EXISTS (
        SELECT 1 FROM "TallySyncOutbox" o
        WHERE o."receiptNo" = p."receiptNo" AND o."action" = 'CREATE'
      )
    LIMIT 500
  `;

  const missingCancels = await prisma.$queryRaw<{ receiptNo: string }[]>`
    SELECT DISTINCT o."receiptNo"
    FROM "TallySyncOutbox" o
    WHERE o."action" = 'CREATE'
      AND o."status" <> 'SKIPPED'
      AND (o."status" = 'SYNCED' OR o."attempts" > 0 OR o."leasedUntil" IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM "Payment" p WHERE p."receiptNo" = o."receiptNo" AND p."status" = 'ACTIVE'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "TallySyncOutbox" c
        WHERE c."receiptNo" = o."receiptNo" AND c."action" = 'CANCEL'
      )
    LIMIT 500
  `;

  const rows = [
    ...missingCreates.map((row) => ({ receiptNo: row.receiptNo, action: "CREATE" as const })),
    ...missingCancels.map((row) => ({ receiptNo: row.receiptNo, action: "CANCEL" as const })),
  ];
  if (rows.length === 0) return 0;
  const { count } = await prisma.tallySyncOutbox.createMany({ data: rows, skipDuplicates: true });
  return count;
}

/* -------------------------------------------------------------------------- */
/* Handing work to the bridge                                                  */
/* -------------------------------------------------------------------------- */

export type TallyJob = {
  id: string;
  receiptNo: string;
  action: "CREATE" | "CANCEL";
  /** Posted to Tally in order. A new student ledger comes before its voucher. */
  requests: TallyRequest[];
};

async function loadReceipt(receiptNo: string): Promise<{ receipt: ReceiptForTally | null; active: boolean; cancellationReason: string | null }> {
  const lines = await prisma.payment.findMany({
    where: { receiptNo },
    orderBy: { receiptSeq: "asc" },
    include: {
      student: { select: { fullName: true, studentCode: true } },
      application: { select: { fullName: true, applicationNo: true } },
    },
  });
  if (lines.length === 0) return { receipt: null, active: false, cancellationReason: null };

  const activeLines = lines.filter((line) => line.status === "ACTIVE");
  // A voided receipt is still described by its lines — the cancel needs its date.
  const described = activeLines.length > 0 ? activeLines : lines;
  const head = described[0];

  const payer = head.student
    ? { name: head.student.fullName, code: head.student.studentCode, isStudent: true }
    : { name: head.application?.fullName ?? "Unknown payer", code: head.application?.applicationNo ?? null, isStudent: false };

  return {
    active: activeLines.length > 0,
    cancellationReason: lines.find((line) => line.cancellationReason)?.cancellationReason ?? null,
    receipt: {
      receiptNo,
      kind: head.kind,
      paymentDate: head.paymentDate,
      mode: head.mode,
      referenceNo: head.referenceNo,
      remarks: head.remarks,
      totalPaise: described.reduce((sum, line) => sum + line.amountPaise, 0),
      lateFeePaise: described.reduce((sum, line) => sum + line.lateFeePortionPaise, 0),
      payer,
    },
  };
}

type Outcome = { job: TallyJob } | { skip: string } | { fail: string } | { wait: true };

async function buildJob(row: TallySyncOutbox, config: Omit<TallyConfig, "updatedAt">): Promise<Outcome> {
  const { receipt, active, cancellationReason } = await loadReceipt(row.receiptNo);
  if (!receipt) return { skip: "The receipt no longer exists in the ERP." };

  if (row.action === "CREATE") {
    // Voided before it was ever sent: nothing to post. Voided after an attempt
    // that may have landed: post it anyway — Tally matches on REMOTEID, so this
    // cannot duplicate — so that the queued CANCEL has a voucher to cancel and
    // Edit Log shows both halves.
    const mayBeInTally = row.attempts > 0 || row.leasedUntil !== null;
    if (!active && !mayBeInTally) return { skip: "Cancelled in the ERP before it reached Tally." };
    if (!isNonCash(receipt.mode)) return { skip: "Cash receipt — not posted to Tally." };

    const debitLedger = debitLedgerFor(config, receipt.mode);
    if (!debitLedger) {
      return { fail: `No Tally ledger is set for ${MODE_LABELS[receipt.mode]} receipts. Set it in Setup › Tally, then retry.` };
    }

    const requests: TallyRequest[] = [];
    const ledgerName = studentLedgerNeeded(config, receipt);
    if (ledgerName && !(await prisma.tallyLedger.findUnique({ where: { name: ledgerName } }))) {
      requests.push({ purpose: "ledger", ledgerName, xml: buildLedgerMasterXml(config, ledgerName) });
    }
    requests.push({ purpose: "voucher", xml: buildReceiptVoucherXml(config, receipt, debitLedger) });
    return { job: { id: row.id, receiptNo: row.receiptNo, action: "CREATE", requests } };
  }

  // CANCEL: only once Tally actually holds the voucher.
  const create = await prisma.tallySyncOutbox.findUnique({
    where: { receiptNo_action: { receiptNo: row.receiptNo, action: "CREATE" } },
  });
  if (!create || create.status === "SKIPPED") return { skip: "The voucher never reached Tally, so there is nothing to cancel." };
  if (create.status !== "SYNCED") return { wait: true };

  return {
    job: {
      id: row.id,
      receiptNo: row.receiptNo,
      action: "CANCEL",
      requests: [
        { purpose: "voucher", xml: buildCancelVoucherXml(config, receipt, create.tallyMasterId, cancellationReason) },
      ],
    },
  };
}

/**
 * Called by the bridge on each poll. Records the heartbeat, sweeps for missed
 * receipts, and claims up to `limit` due rows.
 *
 * Claiming is a conditional update per row, so two bridges polling at once (a
 * second PC left running, say) cannot both take the same voucher — and if one
 * did slip through after a lease expired, Tally matches on REMOTEID and alters
 * rather than duplicating.
 */
export async function leaseTallyJobs(
  limit: number,
  heartbeat: { tallyOnline: boolean },
): Promise<{ enabled: boolean; jobs: TallyJob[] }> {
  await prisma.tallyConfig.upsert({
    where: { id: 1 },
    create: { bridgeLastSeenAt: new Date(), bridgeTallyOnline: heartbeat.tallyOnline },
    update: { bridgeLastSeenAt: new Date(), bridgeTallyOnline: heartbeat.tallyOnline },
  });

  const config = await getTallyConfig();
  if (!config.enabled || limit <= 0) return { enabled: config.enabled, jobs: [] };

  await sweepMissed(config);

  const now = new Date();
  const dueWhere = {
    OR: [
      { status: "PENDING" as const, nextAttemptAt: { lte: now } },
      { status: "IN_FLIGHT" as const, leasedUntil: { lt: now } },
    ],
  };
  // Over-fetch: some rows will turn out to be skips or waiting cancels.
  const candidates = await prisma.tallySyncOutbox.findMany({
    where: dueWhere,
    orderBy: { createdAt: "asc" },
    take: limit * 3,
  });

  const jobs: TallyJob[] = [];
  for (const row of candidates) {
    if (jobs.length >= limit) break;

    const outcome = await buildJob(row, config);
    if ("wait" in outcome) continue;
    if ("skip" in outcome) {
      await prisma.tallySyncOutbox.updateMany({
        where: { id: row.id, ...dueWhere },
        data: { status: "SKIPPED", lastError: outcome.skip, leasedUntil: null },
      });
      continue;
    }
    if ("fail" in outcome) {
      await prisma.tallySyncOutbox.updateMany({
        where: { id: row.id, ...dueWhere },
        data: { status: "FAILED", lastError: outcome.fail, leasedUntil: null },
      });
      continue;
    }

    const claimed = await prisma.tallySyncOutbox.updateMany({
      where: { id: row.id, ...dueWhere },
      data: { status: "IN_FLIGHT", leasedUntil: new Date(Date.now() + LEASE_MS) },
    });
    if (claimed.count === 1) jobs.push(outcome.job);
  }

  return { enabled: true, jobs };
}

/* -------------------------------------------------------------------------- */
/* Acknowledgements                                                            */
/* -------------------------------------------------------------------------- */

export type TallyAck = {
  id: string;
  /** Set when the bridge could not reach Tally at all. */
  transportError?: string;
  responses?: { purpose: "ledger" | "voucher"; ledgerName?: string; httpStatus: number; body: string }[];
};

/** Exponential backoff, a minute doubling to a cap of an hour. */
function nextAttemptAfter(attempts: number): Date {
  const minutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + minutes * 60_000);
}

export async function acknowledgeTallyJob(ack: TallyAck): Promise<"synced" | "retrying" | "failed" | "ignored"> {
  const row = await prisma.tallySyncOutbox.findUnique({ where: { id: ack.id } });
  // Only a row still out with the bridge takes a result; anything else is a
  // late ack for work already settled another way.
  if (!row || row.status !== "IN_FLIGHT") return "ignored";

  let error: string | null = ack.transportError ?? null;
  let masterId: string | null = null;

  if (!error) {
    for (const response of ack.responses ?? []) {
      if (response.httpStatus < 200 || response.httpStatus >= 300) {
        error = `Tally answered HTTP ${response.httpStatus}.`;
        break;
      }
      const parsed = parseTallyResponse(response.body);

      if (response.purpose === "ledger") {
        if (parsed.ok || ledgerAlreadyExists(parsed)) {
          if (response.ledgerName) {
            await prisma.tallyLedger.upsert({
              where: { name: response.ledgerName },
              create: { name: response.ledgerName },
              update: {},
            });
          }
          continue;
        }
        error = `Could not create ledger "${response.ledgerName ?? ""}": ${parsed.messages.join("; ")}`;
        break;
      }

      if (!parsed.ok) {
        error = parsed.messages.join("; ") || "Tally did not import the voucher.";
        break;
      }
      masterId = parsed.lastVoucherId;
    }
    if (!error && !(ack.responses ?? []).some((response) => response.purpose === "voucher")) {
      error = "The bridge reported no voucher response.";
    }
  }

  if (!error) {
    await prisma.tallySyncOutbox.update({
      where: { id: row.id },
      data: {
        status: "SYNCED",
        syncedAt: new Date(),
        lastError: null,
        leasedUntil: null,
        attempts: row.attempts + 1,
        ...(row.action === "CREATE" && masterId ? { tallyMasterId: masterId } : {}),
      },
    });
    return "synced";
  }

  const attempts = row.attempts + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  await prisma.tallySyncOutbox.update({
    where: { id: row.id },
    data: {
      status: giveUp ? "FAILED" : "PENDING",
      attempts,
      lastError: error.slice(0, 1000),
      leasedUntil: null,
      nextAttemptAt: nextAttemptAfter(attempts),
    },
  });
  return giveUp ? "failed" : "retrying";
}

/* -------------------------------------------------------------------------- */
/* For the Setup › Tally screen                                                */
/* -------------------------------------------------------------------------- */

export async function tallyQueueSummary() {
  const grouped = await prisma.tallySyncOutbox.groupBy({ by: ["status"], _count: { _all: true } });
  const counts = { PENDING: 0, IN_FLIGHT: 0, SYNCED: 0, FAILED: 0, SKIPPED: 0 };
  for (const group of grouped) counts[group.status] = group._count._all;
  return counts;
}

export function recentTallyRows(take = 50) {
  return prisma.tallySyncOutbox.findMany({
    orderBy: [{ updatedAt: "desc" }],
    take,
  });
}

/** Put failed rows back in the queue — after a ledger name has been fixed, say. */
export async function retryFailedTally(ids?: string[]): Promise<number> {
  const { count } = await prisma.tallySyncOutbox.updateMany({
    where: { status: "FAILED", ...(ids ? { id: { in: ids } } : {}) },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), leasedUntil: null },
  });
  return count;
}
