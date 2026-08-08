"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { recordAudit, recordAuditTx } from "@/lib/audit";
import { getConfig } from "@/lib/config";
import { endOfDay } from "@/lib/dates";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { allocateFifo, refreshInstallment, refreshInstallmentsBulk } from "@/lib/late-fees";
import { reinstateProvisionalAdmission, settleProvisionalAdmission } from "@/lib/enrollment";
import { runReminderPass } from "@/lib/reminders";
import { formatPaise } from "@/lib/money";
import { formatSequence, nextSequenceValue, SEQ } from "@/lib/sequence";
import { dateInput, fieldErrorsOf, formObject, optionalText, reasonInput, requiredText, rupeeAmount } from "@/lib/validation";
import type { InstallmentStatus } from "@/generated/prisma/client";

const paymentSchema = z.object({
  studentId: requiredText("Student"),
  amountPaise: rupeeAmount("Amount", { min: 1 }),
  // Money cannot be received in the future. Beyond being nonsense on a receipt,
  // a forward-dated payment is assessed against a later late-fee slab, so it
  // silently changes how far the money reaches and which installments it
  // settles — a typo in this field used to be invisible until the receipt
  // printed.
  paymentDate: dateInput("Payment date").refine((value) => value <= endOfDay(new Date()), {
    message: "The payment date cannot be in the future.",
  }),
  mode: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "CHEQUE", "OTHER"]),
  referenceNo: optionalText,
  remarks: optionalText,
});

/**
 * Record one collection against a student. The amount settles installments
 * oldest-due-first (FIFO) and may cover several of them, or part of one
 * (spec 3.1). Within each installment the outstanding late fee is cleared
 * before principal.
 *
 * The collection gets a single receipt number; one Payment row is written per
 * installment the money reached, numbered by `receiptSeq`, so every installment
 * still owns the payments that settled it.
 */
export async function recordPaymentAction(_prev: unknown, formData: FormData): Promise<ActionResult<{ receiptNo: string }>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_COLLECT);
    const parsed = paymentSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { studentId, amountPaise, ...rest } = parsed.data;

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        studentCode: true,
        status: true,
        applicationId: true,
        application: { select: { isProvisional: true } },
      },
    });
    if (!student) return fail("Student not found.");
    if (student.status !== "ACTIVE" && student.status !== "PASSED") {
      return fail("This student is no longer active, so their pending fees have been waived.");
    }

    const [installments, slabs, config, discounts] = await Promise.all([
      prisma.installment.findMany({
        where: { feeAssignment: { studentId } },
        include: { payments: true, feeAssignment: { include: { semester: true } } },
        orderBy: [{ dueDate: "asc" }, { seqNo: "asc" }],
      }),
      prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
      getConfig(),
      // Read alongside the rest so the installments this collection settles can
      // be brought up to date without a query each.
      prisma.discount.findMany({
        where: { installment: { feeAssignment: { studentId } }, cancelledAt: null },
        select: { installmentId: true, amountPaise: true },
      }),
    ]);

    const { allocations, unallocatedPaise } = allocateFifo({
      installments,
      amountPaise,
      slabs,
      config,
      asOf: rest.paymentDate,
      // A provisional admission carries no late fee, so nothing is skimmed off
      // the payment for one.
      lateFeeExempt: student.application.isProvisional,
    });

    if (allocations.length === 0) {
      return fail("This student has nothing outstanding to collect against.");
    }
    if (unallocatedPaise > 0) {
      const collectable = amountPaise - unallocatedPaise;
      return fail(
        `That is ${formatPaise(unallocatedPaise)} more than this student owes. The most that can be collected now is ${formatPaise(collectable)}.`,
        { amountPaise: [`Maximum ${formatPaise(collectable)}.`] },
      );
    }

    const byId = new Map(installments.map((installment) => [installment.id, installment]));
    const discountByInstallment = new Map<string, number>();
    for (const discount of discounts) {
      if (!discount.installmentId) continue;
      discountByInstallment.set(
        discount.installmentId,
        (discountByInstallment.get(discount.installmentId) ?? 0) + discount.amountPaise,
      );
    }

    const receiptNo = await prisma.$transaction(async (tx) => {
      const seq = await nextSequenceValue(SEQ.RECEIPT, tx);
      const number = formatSequence(config.receiptPrefix, seq, config.receiptPadding);

      await tx.payment.createMany({
        data: allocations.map((allocation, index) => ({
          receiptNo: number,
          receiptSeq: index + 1,
          kind: "INSTALLMENT" as const,
          installmentId: allocation.installmentId,
          studentId,
          amountPaise: allocation.amountPaise,
          lateFeePortionPaise: allocation.lateFeePortionPaise,
          collectedById: actor.id,
          ...rest,
        })),
      });

      // Fold the allocations into the copies already in hand and write the
      // resulting states together. A collection reaching a dozen installments
      // used to be six round trips each, inside the transaction.
      await refreshInstallmentsBulk(
        allocations.flatMap((allocation) => {
          const installment = byId.get(allocation.installmentId);
          if (!installment) return [];
          installment.payments.push({
            status: "ACTIVE",
            amountPaise: allocation.amountPaise,
            lateFeePortionPaise: allocation.lateFeePortionPaise,
          } as (typeof installment.payments)[number]);
          return [
            {
              installment,
              asOf: rest.paymentDate,
              lateFeeExempt: student.application.isProvisional,
              discountPaise: discountByInstallment.get(allocation.installmentId) ?? 0,
            },
          ];
        }),
        slabs,
        config,
        tx,
      );

      const breakdown = allocations
        .map((allocation) => {
          const installment = byId.get(allocation.installmentId);
          return `sem ${installment?.feeAssignment.semester.semesterNumber ?? "—"} installment ${
            installment?.seqNo ?? "—"
          }: ${formatPaise(allocation.amountPaise)}`;
        })
        .join(", ");

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.payment_recorded",
        entityType: "Payment",
        entityId: number,
        summary: `${formatPaise(amountPaise)} received from ${student.studentCode} — receipt ${number} (${breakdown})`,
        metadata: { amountPaise, mode: rest.mode, allocations },
      });

      return number;
    });

    // Installment 1 carries the registration money, so settling it confirms a
    // provisional admission without anyone having to remember.
    const { cleared } = await settleProvisionalAdmission(student.applicationId, actor.id);

    revalidatePath("/fees/collect");
    revalidatePath("/fees/receipts");
    revalidatePath(`/students/${studentId}`);
    if (cleared) revalidatePath(`/enrollment/${student.applicationId}`);

    const covered =
      allocations.length === 1
        ? "one installment"
        : `${allocations.length} installments, oldest first`;
    return ok(
      { receiptNo },
      `Payment recorded against ${covered}. Receipt ${receiptNo}.${
        cleared ? " The registration fee is now cleared, so the provisional admission has been confirmed." : ""
      }`,
    );
  });
}

/**
 * Cancel/void a receipt (spec 3.4). Admin only, reason mandatory, no time limit.
 * The row is never deleted and its number is never reused; the affected
 * installment's status and late fee are recalculated against the original due
 * date using the reduced paid amount.
 */
export async function cancelReceiptAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.FEE_CANCEL_RECEIPT);
    const paymentId = String(formData.get("paymentId") ?? "");
    const parsedReason = reasonInput.safeParse(String(formData.get("reason") ?? ""));
    if (!parsedReason.success) {
      return fail("A cancellation reason is required.", { reason: [parsedReason.error.issues[0].message] });
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { student: true, application: true },
    });
    if (!payment) return fail("Receipt not found.");
    if (payment.status === "CANCELLED") return fail("This receipt is already cancelled.");

    // A receipt can carry several allocation lines (one collection spread over
    // installments) — voiding it voids all of them.
    const lines = await prisma.payment.findMany({
      where: { receiptNo: payment.receiptNo, status: "ACTIVE" },
      orderBy: { receiptSeq: "asc" },
    });
    const totalPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);

    const reinstated = await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { receiptNo: payment.receiptNo, status: "ACTIVE" },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledById: actor.id,
          cancellationReason: parsedReason.data,
        },
      });

      // A cancelled registration receipt must stop counting toward the gate.
      const applicationIds = new Set<string>();
      for (const line of lines) {
        if (line.kind !== "REGISTRATION" || !line.applicationId) continue;
        await tx.application.update({
          where: { id: line.applicationId },
          data: { registrationFeePaidPaise: { decrement: line.amountPaise } },
        });
        applicationIds.add(line.applicationId);
      }

      // Taking that money back out can put the admission back to provisional,
      // which suspends late fees — so this runs *before* the installments are
      // recalculated below, or they would be re-assessed under the old status.
      let wentProvisional = false;
      for (const applicationId of applicationIds) {
        const result = await reinstateProvisionalAdmission(applicationId, actor.id, tx);
        wentProvisional = wentProvisional || result.reinstated;
      }

      // Recalculates status and re-assesses late fees against the original due
      // dates. The rows are re-read once, *after* the cancellations and any
      // provisional reinstatement above, so the payments they carry are the
      // surviving ones and the exemption is the one now in force.
      const touched = [...new Set(lines.map((line) => line.installmentId).filter((id): id is string => Boolean(id)))];
      if (touched.length > 0) {
        const [affected, slabs, config, discounts] = await Promise.all([
          tx.installment.findMany({
            where: { id: { in: touched } },
            include: {
              payments: true,
              feeAssignment: { select: { student: { select: { application: { select: { isProvisional: true } } } } } },
            },
          }),
          tx.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
          getConfig(tx),
          tx.discount.findMany({
            where: { installmentId: { in: touched }, cancelledAt: null },
            select: { installmentId: true, amountPaise: true },
          }),
        ]);
        const discountByInstallment = new Map<string, number>();
        for (const discount of discounts) {
          if (!discount.installmentId) continue;
          discountByInstallment.set(
            discount.installmentId,
            (discountByInstallment.get(discount.installmentId) ?? 0) + discount.amountPaise,
          );
        }
        const now = new Date();
        await refreshInstallmentsBulk(
          affected.map((installment) => ({
            installment,
            asOf: now,
            lateFeeExempt: installment.feeAssignment.student.application.isProvisional,
            discountPaise: discountByInstallment.get(installment.id) ?? 0,
          })),
          slabs,
          config,
          tx,
        );
      }

      await recordAuditTx(tx, {
        userId: actor.id,
        action: "fee.receipt_cancelled",
        entityType: "Payment",
        entityId: payment.receiptNo,
        summary: `Receipt ${payment.receiptNo} for ${formatPaise(totalPaise)} cancelled${
          payment.student ? ` (${payment.student.studentCode})` : ""
        }${lines.length > 1 ? ` — ${lines.length} installment allocations` : ""}`,
        reason: parsedReason.data,
        metadata: {
          originalTransactionReference: payment.referenceNo,
          amountPaise: totalPaise,
          lines: lines.length,
          paymentDate: payment.paymentDate,
          kind: payment.kind,
          provisionalReinstated: wentProvisional,
        },
      });

      return wentProvisional;
    });

    revalidatePath("/fees/receipts");
    revalidatePath("/fees/collect");
    revalidatePath("/enrollment");
    if (payment.studentId) revalidatePath(`/students/${payment.studentId}`);
    if (payment.applicationId) revalidatePath(`/enrollment/${payment.applicationId}`);
    return ok(
      undefined,
      `Receipt ${payment.receiptNo} voided. The number is retained and the installment has been recalculated.` +
        (reinstated
          ? " The registration fee no longer clears the minimum, so the admission is provisional again and late fees are suspended."
          : ""),
    );
  });
}

/** Recompute late fees across all open installments — also done by the nightly job. */
export async function recalculateLateFeesAction(
  _prev?: unknown,
  _formData?: FormData,
): Promise<ActionResult<{ updated: number }>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);

    // Every open installment in the institute, so this is the one place where a
    // call per row is unbounded — it grew with the roll and would eventually
    // outlast the request. Four reads, then the writes grouped by outcome.
    const openStatuses: InstallmentStatus[] = ["PENDING", "PARTIALLY_PAID"];
    const [open, slabs, config, discounts] = await Promise.all([
      prisma.installment.findMany({
        where: { status: { in: openStatuses } },
        include: {
          payments: true,
          feeAssignment: {
            select: { student: { select: { application: { select: { isProvisional: true } } } } },
          },
        },
      }),
      prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
      getConfig(),
      prisma.discount.findMany({
        where: { installment: { is: { status: { in: openStatuses } } }, cancelledAt: null },
        select: { installmentId: true, amountPaise: true },
      }),
    ]);

    const discountByInstallment = new Map<string, number>();
    for (const discount of discounts) {
      if (!discount.installmentId) continue;
      discountByInstallment.set(
        discount.installmentId,
        (discountByInstallment.get(discount.installmentId) ?? 0) + discount.amountPaise,
      );
    }

    const asOf = new Date();
    await refreshInstallmentsBulk(
      open.map((installment) => ({
        installment,
        asOf,
        lateFeeExempt: installment.feeAssignment.student.application.isProvisional,
        discountPaise: discountByInstallment.get(installment.id) ?? 0,
      })),
      slabs,
      config,
    );

    await recordAudit({
      userId: actor.id,
      action: "fee.late_fees_recalculated",
      summary: `Late fees recalculated across ${open.length} open installment(s)`,
    });
    revalidatePath("/fees/reminders");
    revalidatePath("/fees/collect");
    return ok({ updated: open.length }, `Recalculated ${open.length} installment(s).`);
  });
}

/** Trigger a reminder pass by hand — the same code the scheduled job runs. */
export async function runRemindersAction(
  _prev?: unknown,
  _formData?: FormData,
): Promise<ActionResult<{ preDueSent: number; overdueSent: number }>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const result = await runReminderPass();

    await recordAudit({
      userId: actor.id,
      action: "fee.reminders_run",
      summary: `Reminder pass run manually — ${result.preDueSent} pre-due, ${result.overdueSent} overdue, ${result.failures} failure(s) across ${result.scanned} installment(s)`,
    });
    revalidatePath("/fees/reminders");
    return ok(
      { preDueSent: result.preDueSent, overdueSent: result.overdueSent },
      `Sent ${result.preDueSent} pre-due and ${result.overdueSent} overdue message(s); ${result.failures} failure(s).`,
    );
  });
}
