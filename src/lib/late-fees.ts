import "server-only";
import { prisma, type Db } from "@/lib/db";
import { daysOverdue } from "@/lib/dates";
import type { InstituteConfig, LateFeeSlab, Installment, Payment } from "@/generated/prisma/client";

/**
 * Late fee engine (spec 3.2).
 *
 * Rules, in the order they are applied:
 *   0. Nothing accrues for time before `lateFeeEffectiveFrom`, the day the
 *      policy starts counting. An installment overdue since April, with the
 *      policy starting in August, is two days chargeable on the third of
 *      August — not a hundred and eighteen.
 *   1. Nothing accrues within the Admin-configured grace period.
 *   2. If the remaining unpaid principal is at or below the Minimum
 *      Outstanding Threshold, no late fee applies at all — however overdue.
 *   3. Above that threshold the matching slab's amount applies in full: flat,
 *      never prorated.
 *   4. Accrual stops once principal and late fee are both settled.
 *
 * Money already received is applied to any outstanding late fee first, then to
 * principal, so `lateFeePortionPaise` on each Payment records the split.
 */

/** The config the engine reads. */
export type LateFeeConfig = Pick<
  InstituteConfig,
  "lateFeeGraceDays" | "minOutstandingThresholdPaise" | "lateFeeEffectiveFrom"
>;

/**
 * Days of lateness the slabs are allowed to see.
 *
 * The real overdue figure is kept separately and untouched: it is what the Fee
 * Due report, the overdue buckets and the reminders quote, and a family two
 * days into a new policy is still four months late.
 */
export function chargeableDaysOverdue(dueDate: Date, asOf: Date, effectiveFrom: Date | null): number {
  const from = effectiveFrom && effectiveFrom > dueDate ? effectiveFrom : dueDate;
  return daysOverdue(from, asOf);
}

export type InstallmentBalance = {
  /** Original installment amount, before any discount. */
  principalPaise: number;
  /** Admin-granted concession on this installment (spec 2.2 extension). */
  discountPaise: number;
  /** What is actually payable: the amount less any discount. */
  netPayablePaise: number;
  /** Principal settled by active (non-cancelled) payments. */
  principalPaidPaise: number;
  /** Principal still owed. */
  principalOutstandingPaise: number;
  /** Late fee currently assessed against this installment, before any waiver. */
  lateFeeAssessedPaise: number;
  /** Part of that fee written off by an Accountant or Admin. */
  lateFeeWaivedPaise: number;
  /** Late fee already settled. */
  lateFeePaidPaise: number;
  /** Late fee still owed. */
  lateFeeOutstandingPaise: number;
  /** Principal + late fee still owed. */
  totalOutstandingPaise: number;
  daysOverdue: number;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID" | "WAIVED";
};

export function pickSlab(slabs: LateFeeSlab[], days: number): LateFeeSlab | null {
  return (
    slabs.find(
      (slab) => slab.isActive && days >= slab.minDaysOverdue && (slab.maxDaysOverdue === null || days <= slab.maxDaysOverdue),
    ) ?? null
  );
}

/**
 * `daysPastDue` must already be the *chargeable* figure — see
 * `chargeableDaysOverdue`, which is what applies the policy start date.
 */
export function computeLateFee({
  slabs,
  config,
  daysPastDue,
  principalOutstandingPaise,
}: {
  slabs: LateFeeSlab[];
  config: Pick<InstituteConfig, "lateFeeGraceDays" | "minOutstandingThresholdPaise">;
  daysPastDue: number;
  principalOutstandingPaise: number;
}): number {
  if (principalOutstandingPaise <= 0) return 0;
  // Rule 1 — inside the grace window nothing is charged.
  if (daysPastDue <= config.lateFeeGraceDays) return 0;
  // Rule 2 — small balances are exempt entirely.
  if (principalOutstandingPaise <= config.minOutstandingThresholdPaise) return 0;
  // Rule 3 — flat slab amount.
  return pickSlab(slabs, daysPastDue)?.amountPaise ?? 0;
}

type InstallmentWithPayments = Installment & { payments: Payment[] };

/**
 * `lateFeeExempt` switches accrual off entirely for this student. It is set
 * while an admission is provisional: the registration fee has not been cleared,
 * so the admission is not confirmed, and no late fee can be charged on it
 * (spec 1.4 / 3.2). Accrual resumes from the moment the admission is confirmed.
 */
export function balanceOf(
  installment: InstallmentWithPayments,
  slabs: LateFeeSlab[],
  config: LateFeeConfig,
  asOf: Date = new Date(),
  lateFeeExempt = false,
): InstallmentBalance {
  const active = installment.payments.filter((p) => p.status === "ACTIVE");
  const lateFeePaidPaise = active.reduce((sum, p) => sum + p.lateFeePortionPaise, 0);
  const principalPaidPaise = active.reduce((sum, p) => sum + (p.amountPaise - p.lateFeePortionPaise), 0);

  // Never let a stale cached discount exceed the installment itself.
  const discountPaise = Math.min(Math.max(0, installment.discountPaise), installment.amountPaise);
  const netPayablePaise = installment.amountPaise - discountPaise;

  if (installment.status === "WAIVED") {
    return {
      principalPaise: installment.amountPaise,
      discountPaise,
      netPayablePaise,
      principalPaidPaise,
      principalOutstandingPaise: 0,
      lateFeeAssessedPaise: 0,
      lateFeeWaivedPaise: 0,
      lateFeePaidPaise,
      lateFeeOutstandingPaise: 0,
      totalOutstandingPaise: 0,
      daysOverdue: 0,
      status: "WAIVED",
    };
  }

  // A discount reduces what is owed, so the late fee accrues on the net figure
  // and a fully-discounted installment settles itself.
  const principalOutstandingPaise = Math.max(0, netPayablePaise - principalPaidPaise);
  // How late they actually are, which is what gets reported…
  const days = daysOverdue(installment.dueDate, asOf);
  // …and how much of that lateness the policy is allowed to charge for.
  const chargeableDays = chargeableDaysOverdue(installment.dueDate, asOf, config.lateFeeEffectiveFrom ?? null);
  // A written-off late fee stops accruing for good, so the nightly job cannot
  // quietly put it back. Late fee already collected is not refunded — it stays
  // recorded against the payments that settled it.
  const lateFeeAssessedPaise =
    lateFeeExempt || installment.lateFeeWaived
      ? 0
      : computeLateFee({
          slabs,
          config,
          daysPastDue: chargeableDays,
          principalOutstandingPaise,
        });
  // A partial write-off is a credit against the assessed fee; it can never
  // exceed it, however the slabs move afterwards.
  const lateFeeWaivedPaise = Math.min(Math.max(0, installment.lateFeeWaivedPaise), lateFeeAssessedPaise);
  const lateFeeOutstandingPaise = Math.max(0, lateFeeAssessedPaise - lateFeeWaivedPaise - lateFeePaidPaise);
  const totalOutstandingPaise = principalOutstandingPaise + lateFeeOutstandingPaise;

  const status =
    totalOutstandingPaise <= 0
      ? "PAID"
      : principalPaidPaise + lateFeePaidPaise > 0 || discountPaise > 0
        ? "PARTIALLY_PAID"
        : "PENDING";

  return {
    principalPaise: installment.amountPaise,
    discountPaise,
    netPayablePaise,
    principalPaidPaise,
    principalOutstandingPaise,
    lateFeeAssessedPaise,
    lateFeeWaivedPaise,
    lateFeePaidPaise,
    lateFeeOutstandingPaise,
    totalOutstandingPaise,
    daysOverdue: days,
    status,
  };
}

/**
 * Recompute an installment's cached late fee and status and persist them.
 * Called after every payment, every cancellation, and by the nightly job.
 */
export async function refreshInstallment(
  installmentId: string,
  db: Db = prisma,
  asOf: Date = new Date(),
): Promise<InstallmentBalance | null> {
  const installment = await db.installment.findUnique({
    where: { id: installmentId },
    include: {
      payments: true,
      feeAssignment: { select: { student: { select: { application: { select: { isProvisional: true } } } } } },
    },
  });
  if (!installment) return null;

  const [slabs, config, discounts] = await Promise.all([
    db.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
    db.instituteConfig.findUniqueOrThrow({ where: { id: 1 } }),
    db.discount.findMany({ where: { installmentId, cancelledAt: null }, select: { amountPaise: true } }),
  ]);

  // Recompute the cached discount from the live Discount rows before the balance
  // is worked out, so granting or cancelling one takes effect immediately.
  const discountPaise = Math.min(
    discounts.reduce((sum, discount) => sum + discount.amountPaise, 0),
    installment.amountPaise,
  );

  // No late fee while the admission is still provisional.
  const exempt = installment.feeAssignment.student.application.isProvisional;
  const balance = balanceOf({ ...installment, discountPaise }, slabs, config, asOf, exempt);

  // A waived installment keeps its status until Admin un-waives it.
  if (installment.status !== "WAIVED") {
    await db.installment.update({
      where: { id: installmentId },
      data: {
        status: balance.status,
        discountPaise,
        lateFeePaise: balance.lateFeeAssessedPaise,
        lateFeeUpdatedAt: new Date(),
      },
    });
  } else if (installment.discountPaise !== discountPaise) {
    await db.installment.update({ where: { id: installmentId }, data: { discountPaise } });
  }

  return balance;
}

export type InstallmentRefresh = {
  /** The installment with its payments — including any just applied in memory. */
  installment: InstallmentWithPayments;
  /** The date the late fee is assessed as of; a payment's own date, usually. */
  asOf: Date;
  lateFeeExempt: boolean;
  /** Live discount total. Falls back to the value cached on the row. */
  discountPaise?: number;
};

/**
 * Persist what `refreshInstallment` would compute, for several installments at
 * once.
 *
 * `refreshInstallment` re-reads the slabs, the config and the discounts on
 * every call, so using it in a loop is four or five round trips per
 * installment. Anywhere a single act touches many — one collection spread
 * across installments, an imported register, a cancelled receipt — that is what
 * exhausts the transaction budget. Here the caller has already worked the
 * balances out in memory, so the only cost is the writes, and rows sharing an
 * outcome (most simply end up PAID) go in one statement.
 *
 * A waived installment keeps its status until Admin un-waives it, exactly as it
 * does in the single-row version.
 */
export async function refreshInstallmentsBulk(
  entries: InstallmentRefresh[],
  slabs: LateFeeSlab[],
  config: LateFeeConfig,
  db: Db = prisma,
): Promise<number> {
  const grouped = new Map<string, string[]>();

  for (const entry of entries) {
    if (entry.installment.status === "WAIVED") continue;
    const discountPaise = Math.min(
      Math.max(0, entry.discountPaise ?? entry.installment.discountPaise),
      entry.installment.amountPaise,
    );
    const balance = balanceOf(
      { ...entry.installment, discountPaise },
      slabs,
      config,
      entry.asOf,
      entry.lateFeeExempt,
    );
    const key = `${balance.status}|${balance.lateFeeAssessedPaise}|${discountPaise}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry.installment.id]);
  }

  const lateFeeUpdatedAt = new Date();
  let updated = 0;
  for (const [key, ids] of grouped) {
    const [status, lateFeePaise, discountPaise] = key.split("|");
    await db.installment.updateMany({
      where: { id: { in: ids } },
      data: {
        status: status as InstallmentBalance["status"],
        discountPaise: Number(discountPaise),
        lateFeePaise: Number(lateFeePaise),
        lateFeeUpdatedAt,
      },
    });
    updated += ids.length;
  }
  return updated;
}

/**
 * Spread one amount over installments oldest-due-first (FIFO). Within each
 * installment the outstanding late fee is settled before principal, exactly as
 * a single-installment payment does.
 *
 * `installments` must already be ordered by due date. Waived installments are
 * skipped — money never lands on them.
 */
export type Allocation = {
  installmentId: string;
  amountPaise: number;
  lateFeePortionPaise: number;
};

export function allocateFifo({
  installments,
  amountPaise,
  slabs,
  config,
  asOf = new Date(),
  lateFeeExempt = false,
}: {
  installments: InstallmentWithPayments[];
  amountPaise: number;
  slabs: LateFeeSlab[];
  config: LateFeeConfig;
  asOf?: Date;
  lateFeeExempt?: boolean;
}): { allocations: Allocation[]; unallocatedPaise: number } {
  let remaining = amountPaise;
  const allocations: Allocation[] = [];

  for (const installment of installments) {
    if (remaining <= 0) break;
    if (installment.status === "WAIVED") continue;

    const balance = balanceOf(installment, slabs, config, asOf, lateFeeExempt);
    if (balance.totalOutstandingPaise <= 0) continue;

    const applied = Math.min(remaining, balance.totalOutstandingPaise);
    allocations.push({
      installmentId: installment.id,
      amountPaise: applied,
      lateFeePortionPaise: Math.min(applied, balance.lateFeeOutstandingPaise),
    });
    remaining -= applied;
  }

  return { allocations, unallocatedPaise: remaining };
}

/**
 * How much late fee can still be waived on an installment: what is still owed,
 * plus anything already collected that has not yet been credited back.
 *
 * A fee that has been paid is just as waivable as one that has not — the
 * decision to let a family off often comes after the receipt has been issued.
 * The collected part is handed back as a credit against what they owe next
 * rather than as cash (see `waiveLateFeeAction`), so it stops being waivable
 * once credited.
 */
export function waivableLateFeePaise(installment: {
  /** Late fee assessed on the installment — `lateFeePaise`. */
  assessedPaise: number;
  waivedPaise: number;
  /** Late fee settled by active payments. */
  paidPaise: number;
  creditedPaise: number;
}): { unpaidPaise: number; collectedPaise: number; totalPaise: number } {
  const unpaidPaise = Math.max(0, installment.assessedPaise - installment.waivedPaise - installment.paidPaise);
  const collectedPaise = Math.max(0, installment.paidPaise - installment.creditedPaise);
  return { unpaidPaise, collectedPaise, totalPaise: unpaidPaise + collectedPaise };
}

/** Overdue bucket used by the Fee Due report (spec 7). */
export function overdueBucket(days: number): "0-7" | "8-15" | "16-30" | "30+" | "not-due" {
  if (days <= 0) return "not-due";
  if (days <= 7) return "0-7";
  if (days <= 15) return "8-15";
  if (days <= 30) return "16-30";
  return "30+";
}
