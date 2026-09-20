"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { checkboxInput, fieldErrorsOf, formObject, optionalDateInput, optionalText } from "@/lib/validation";
import { retryFailedTally } from "@/lib/tally/outbox";

const ledgerName = (label: string) => z.string().trim().min(1, `${label} is required.`).max(200);

const configSchema = z
  .object({
    enabled: checkboxInput,
    companyName: optionalText,
    voucherTypeName: ledgerName("Voucher type"),
    syncFrom: optionalDateInput,
    ledgerUpi: optionalText,
    ledgerCard: optionalText,
    ledgerBankTransfer: optionalText,
    ledgerCheque: optionalText,
    ledgerOther: optionalText,
    creditMode: z.enum(["FIXED", "STUDENT"]),
    feeLedger: ledgerName("Fee ledger"),
    registrationLedger: ledgerName("Registration ledger"),
    lateFeeLedger: optionalText,
    studentLedgerGroup: ledgerName("Student ledger group"),
    sendBankAllocations: checkboxInput,
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    // Without a start date, switching on would post every non-cash receipt the
    // institute has ever taken.
    if (!value.syncFrom) {
      ctx.addIssue({ code: "custom", path: ["syncFrom"], message: "Choose the first date to post from." });
    }
    const anyLedger = [value.ledgerUpi, value.ledgerCard, value.ledgerBankTransfer, value.ledgerCheque, value.ledgerOther].some(Boolean);
    if (!anyLedger) {
      ctx.addIssue({ code: "custom", path: ["ledgerUpi"], message: "Map at least one payment mode to a Tally ledger." });
    }
  });

export async function saveTallyConfigAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const parsed = configSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const data = {
      ...parsed.data,
      companyName: parsed.data.companyName ?? null,
      syncFrom: parsed.data.syncFrom ?? null,
      ledgerUpi: parsed.data.ledgerUpi ?? null,
      ledgerCard: parsed.data.ledgerCard ?? null,
      ledgerBankTransfer: parsed.data.ledgerBankTransfer ?? null,
      ledgerCheque: parsed.data.ledgerCheque ?? null,
      ledgerOther: parsed.data.ledgerOther ?? null,
      lateFeeLedger: parsed.data.lateFeeLedger ?? null,
    };
    await prisma.tallyConfig.upsert({ where: { id: 1 }, create: data, update: data });

    await recordAudit({
      userId: actor.id,
      action: "tally.config_updated",
      entityType: "TallyConfig",
      entityId: "1",
      summary: `Tally connector ${data.enabled ? "enabled" : "disabled"} and settings saved`,
      metadata: data,
    });

    revalidatePath("/setup/tally");
    return ok(undefined, data.enabled ? "Saved. Non-cash receipts will now be posted to Tally." : "Saved. The connector is off.");
  });
}

export async function retryFailedTallyAction(_prev: unknown, _formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const count = await retryFailedTally();
    await recordAudit({
      userId: actor.id,
      action: "tally.retry_failed",
      summary: `Re-queued ${count} failed Tally voucher(s)`,
    });
    revalidatePath("/setup/tally");
    return ok(undefined, count === 0 ? "Nothing had failed." : `Re-queued ${count} voucher(s). The bridge picks them up on its next poll.`);
  });
}
