import "server-only";
import { prisma, type Db } from "@/lib/db";
import { requestContext } from "@/lib/auth";

export type AuditInput = {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  /** Mandatory business reason where the spec requires one. */
  reason?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Append an audit row (spec 8.4). Never throws — a failed audit write must not
 * roll back the user's action when it is called outside a transaction.
 */
export async function recordAudit(input: AuditInput, db: Db = prisma): Promise<void> {
  try {
    const { ipAddress, userAgent } = await requestContext();
    await db.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        summary: input.summary,
        reason: input.reason ?? null,
        metadata: (input.metadata ?? undefined) as never,
        ipAddress,
        userAgent,
      },
    });
  } catch (error) {
    console.error("[audit] failed to record", input.action, error);
  }
}

/**
 * Same as `recordAudit` but inside an open transaction, where a failure *should*
 * roll the whole unit of work back — an approval without its audit trail is not
 * an acceptable outcome.
 */
export async function recordAuditTx(db: Db, input: AuditInput): Promise<void> {
  const { ipAddress, userAgent } = await requestContext();
  await db.auditLog.create({
    data: {
      userId: input.userId ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      summary: input.summary,
      reason: input.reason ?? null,
      metadata: (input.metadata ?? undefined) as never,
      ipAddress,
      userAgent,
    },
  });
}
