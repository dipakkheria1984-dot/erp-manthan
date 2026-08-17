import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getConfig, getInstitute } from "@/lib/config";
import { deliver, deliverEmail } from "@/lib/notifications";
import { formatPaise } from "@/lib/money";
import { AppError } from "@/lib/errors";
import type { Application } from "@/generated/prisma/client";

/**
 * The public admission form (`/apply`).
 *
 * An applicant fills in their own details, guardians, department and course,
 * and uploads their documents. Then they stop. The batch, the fee plan, the
 * registration fee and the submission itself stay with the Registrar, so the
 * record is left as a DRAFT carrying `applicantSubmittedAt` — see the
 * `Application.source` comment in the schema.
 *
 * ## What stands in for a login
 *
 * There is none. The only credential is the link, so it is built like one:
 * 32 random bytes, held as a SHA-256 hash rather than in the clear, given an
 * expiry, and compared in constant time. A leaked database therefore does not
 * hand over every open application, and a stolen link opens exactly one.
 *
 * The token is deliberately *not* the application id: ids appear in staff URLs
 * and audit rows, and one leaking would otherwise be enough to edit the
 * application from outside.
 */

/** How the raw token travels: in the path of `/apply/<token>`. */
export type IssuedToken = { token: string; hash: string; expiresAt: Date };

function hashToken(token: string): string {
  // Salted with the app secret so a stolen database cannot be attacked with a
  // precomputed table of random-token hashes.
  return createHash("sha256").update(`${token}${env.authSecret}`).digest("hex");
}

export async function issuePortalToken(): Promise<IssuedToken> {
  const config = await getConfig();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.onlineAdmissionsLinkDays * 24 * 60 * 60 * 1000);
  return { token, hash: hashToken(token), expiresAt };
}

/** Why a token did not resolve — each answers with its own screen, not a 404. */
export type PortalRejection = "unknown" | "expired" | "finished" | "closed";

export type PortalResult =
  | { ok: true; application: Application }
  | { ok: false; reason: PortalRejection };

/**
 * The application a token belongs to, if it may still be edited.
 *
 * Every public read and write goes through here — there is no other way in, so
 * the status rules live in one place. An applicant may edit only while the
 * record is still a DRAFT they have not finished: once they submit, or once the
 * office moves it on, the link becomes read-only.
 */
export async function applicationForToken(token: string): Promise<PortalResult> {
  const config = await getConfig();
  if (!config.onlineAdmissionsEnabled) return { ok: false, reason: "closed" };
  if (!token) return { ok: false, reason: "unknown" };

  const hash = hashToken(token);
  const application = await prisma.application.findUnique({ where: { portalTokenHash: hash } });
  if (!application?.portalTokenHash) return { ok: false, reason: "unknown" };

  // The lookup above is already exact, so this only guards against a future
  // change to a non-unique scan; it costs nothing and cannot hurt.
  const a = Buffer.from(application.portalTokenHash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "unknown" };

  if (application.portalTokenExpiresAt && application.portalTokenExpiresAt < new Date()) {
    return { ok: false, reason: "expired" };
  }
  if (application.applicantSubmittedAt || application.status !== "DRAFT") {
    return { ok: false, reason: "finished" };
  }
  return { ok: true, application };
}

/** The same check for a write, throwing the way the action helpers expect. */
export async function requireEditableApplication(token: string): Promise<Application> {
  const result = await applicationForToken(token);
  if (result.ok) return result.application;

  throw new AppError(
    result.reason === "expired"
      ? "This link has expired. Please contact the admissions office."
      : result.reason === "finished"
        ? "This application has already been submitted and can no longer be edited."
        : result.reason === "closed"
          ? "Online admissions are closed."
          : "This link no longer works. It may already have been used to send your form in.",
  );
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The caller's address, as far as it can be trusted.
 *
 * Behind Vercel `x-forwarded-for` is set by the platform and its first entry is
 * the real client. Off-platform it is client-supplied and therefore spoofable —
 * which is worth saying plainly: this meters casual abuse, it is not a defence
 * against someone determined. The form's real protection is that it writes only
 * DRAFT rows that a human has to pick up.
 */
async function callerKey(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip") || "unknown";
}

/**
 * Fixed-window counter. Returns false when the caller is over the limit.
 *
 * Fixed rather than sliding: it is one upsert instead of a row per event, and
 * the failure mode — up to twice the limit across a window boundary — does not
 * matter for what this is protecting.
 */
export async function withinRateLimit(action: string, limit: number, windowMs: number): Promise<boolean> {
  const key = `${action}:${await callerKey()}`;
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);

  // Created at zero, so the row means "events so far in this window" and the
  // single increment below is the only thing that counts one. Seeding it at 1
  // and then incrementing would spend two of the allowance on the first call.
  const row = await prisma.rateLimit.upsert({
    where: { key },
    create: { key, windowStart, count: 0 },
    update: {},
  });

  // A stale row belongs to a window that has passed: start counting again
  // rather than carry its total forward. Done as a second statement because the
  // upsert cannot branch on the stored value.
  const soFar = row.windowStart.getTime() === windowStart.getTime() ? row.count : 0;
  if (soFar >= limit) return false;

  await prisma.rateLimit.update({ where: { key }, data: { windowStart, count: soFar + 1 } });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Links and notifications                                                     */
/* -------------------------------------------------------------------------- */

/** Absolute base URL of this deployment, for links inside emails. */
export function appBaseUrl(): string {
  return env.appUrl.replace(/\/$/, "");
}

export function applyLinkFor(token: string): string {
  return `${appBaseUrl()}/apply/${token}`;
}

/**
 * Emails the applicant their resume link.
 *
 * Sent on both channels like every other applicant-facing message, because an
 * applicant who gave only a phone number would otherwise have no way back to a
 * half-finished form.
 */
export async function sendApplicantLink(application: Application, token: string): Promise<void> {
  const institute = await getInstitute().catch(() => null);
  const instituteName = institute?.name ?? "the institute";
  const link = applyLinkFor(token);
  const config = await getConfig();

  await deliver({
    kind: "APPLICATION_LINK",
    applicationId: application.id,
    recipient: { email: application.email || null, phone: application.phone || null },
    subject: `Your admission form — ${instituteName}`,
    body:
      `Dear ${application.fullName},\n\n` +
      `Here is your admission form. Open it any time to carry on where you left off:\n\n${link}\n\n` +
      `The link is personal to you — please do not share it. It works for ` +
      `${config.onlineAdmissionsLinkDays} days.\n\n` +
      `Once you have filled in your details and uploaded your documents, our admissions office ` +
      `will take it from there and contact you about the fees.\n\n— ${instituteName}`,
  });
}

/**
 * Tells the office an online form has come in and is waiting on them.
 *
 * `outstandingDocuments` are the required ones the applicant did not upload.
 * Uploading is not compulsory — they may bring physical copies once their
 * admission is confirmed — so the office needs to know what to ask for rather
 * than the applicant being stopped at the last screen.
 */
export async function notifyOfficeOfApplication(
  application: Application,
  outstandingDocuments: string[] = [],
): Promise<void> {
  const institute = await getInstitute().catch(() => null);
  if (!institute?.contactEmail) return;

  const [department, course] = await Promise.all([
    application.departmentId
      ? prisma.department.findUnique({ where: { id: application.departmentId }, select: { name: true } })
      : null,
    application.courseId
      ? prisma.course.findUnique({ where: { id: application.courseId }, select: { name: true } })
      : null,
  ]);

  const documentCount = await prisma.applicationDocument.count({ where: { applicationId: application.id } });

  await deliverEmail({
    kind: "APPLICATION_ONLINE_RECEIVED",
    to: institute.contactEmail,
    applicationId: application.id,
    subject: `Online admission form completed — ${application.fullName}`,
    body:
      `${application.fullName} has completed the online admission form.\n\n` +
      `Department: ${department?.name ?? "—"}\n` +
      `Course: ${course?.name ?? "—"}\n` +
      `Phone: ${application.phone || "—"}\n` +
      `Email: ${application.email || "—"}\n` +
      `Documents uploaded: ${documentCount}\n` +
      (outstandingDocuments.length > 0
        ? `Still to be collected in physical copy: ${outstandingDocuments.join(", ")}\n`
        : `Nothing outstanding — every required document was uploaded.\n`) +
      (application.claimedPaymentReference
        ? `\nThe applicant reports paying ${formatPaise(application.claimedPaymentPaise ?? 0)} online, ` +
          `reference ${application.claimedPaymentReference}. NOT VERIFIED — the bank's page reports nothing ` +
          `back to the system. Check it against the statement, then record it on the Registration fee tab; ` +
          `until you do, no receipt exists and the admission stays provisional.\n`
        : `\nNo online payment reported.\n`) +
      `\nThe batch, fee plan and registration fee are still to be set. Open it here:\n` +
      `${appBaseUrl()}/enrollment/${application.id}\n`,
  });
}
