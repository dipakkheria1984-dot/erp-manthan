import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { getCommunicationConfig, getInstitute } from "@/lib/config";
import { formatPaise } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import {
  emailProviderFor,
  whatsappProviderFor,
  type Attachment,
  type NotificationProvider,
} from "@/lib/notification-providers";
import type { NotificationKind } from "@/generated/prisma/client";

/**
 * Notification dispatch.
 *
 * Spec 3.3: every reminder goes out on Email **and** WhatsApp together — this is
 * not configurable per student or per institute. `deliver` therefore always
 * fans out to both channels and links the pair with a shared `groupKey`.
 *
 * Failures are recorded on the NotificationLog row rather than thrown, so a
 * bounced address never rolls back the business action that triggered it.
 */

type Recipient = { email: string | null; phone: string | null };

/**
 * The two providers a reminder fans out to, resolved once.
 *
 * A one-off notification can let `deliver` look them up for itself. The nightly
 * reminder pass sends hundreds in a row, and re-reading the communication
 * configuration for each one is a round trip per message that buys nothing —
 * the settings cannot change mid-pass.
 */
export type Channels = { email: NotificationProvider; whatsapp: NotificationProvider };

export async function resolveChannels(): Promise<Channels> {
  const config = await getCommunicationConfig();
  return { email: emailProviderFor(config), whatsapp: whatsappProviderFor(config) };
}

type DeliverInput = {
  kind: NotificationKind;
  recipient: Recipient;
  subject: string;
  body: string;
  studentId?: string;
  applicationId?: string;
  installmentId?: string;
  /** Pre-resolved providers. Looked up per call when absent. */
  channels?: Channels;
  /**
   * Values for this kind's approved WhatsApp template, in the order
   * src/lib/whatsapp-templates.ts declares. Email ignores them and sends
   * `body`; a template-only gateway can send nothing without them.
   */
  templateVariables?: string[];
};

export async function deliver(input: DeliverInput): Promise<{ sent: number; failed: number }> {
  const { email, whatsapp } = input.channels ?? (await resolveChannels());
  const groupKey = randomUUID();

  const targets = [
    { channel: "EMAIL" as const, provider: email, to: input.recipient.email ?? "" },
    { channel: "WHATSAPP" as const, provider: whatsapp, to: input.recipient.phone ?? "" },
  ];

  let sent = 0;
  let failed = 0;

  for (const target of targets) {
    const log = await prisma.notificationLog.create({
      data: {
        kind: input.kind,
        channel: target.channel,
        groupKey,
        studentId: input.studentId ?? null,
        applicationId: input.applicationId ?? null,
        installmentId: input.installmentId ?? null,
        recipient: target.to,
        subject: input.subject,
        body: input.body,
        provider: target.provider.name,
      },
    });

    const result = await target.provider.send({
      to: target.to,
      subject: input.subject,
      body: input.body,
      kind: input.kind,
      templateVariables: input.templateVariables,
    });

    if (result.ok) {
      sent += 1;
      await prisma.notificationLog.update({
        where: { id: log.id },
        data: { status: "SENT", sentAt: new Date(), providerMessageId: result.providerMessageId ?? null },
      });
    } else {
      failed += 1;
      // Flagged to Admin on the Reminders screen (spec 3.3).
      await prisma.notificationLog.update({
        where: { id: log.id },
        data: { status: "FAILED", error: result.error },
      });
    }
  }

  return { sent, failed };
}

/**
 * Send one email, with files attached, and record it in the notification log.
 *
 * Separate from `deliver` on purpose. `deliver` exists for reminders, which the
 * spec requires to go out on Email *and* WhatsApp together; this is for a member
 * of staff pressing "Email" on a document, where the whole point is the
 * attachment and the text adapters have nowhere to put one.
 *
 * Like `deliver`, a delivery failure is recorded rather than thrown — the caller
 * reports it to the user, and the log is what Admin reviews later.
 */
export async function deliverEmail(input: {
  kind: NotificationKind;
  to: string;
  subject: string;
  body: string;
  attachments?: Attachment[];
  studentId?: string;
  applicationId?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = await getCommunicationConfig();
  const provider = emailProviderFor(config);

  const log = await prisma.notificationLog.create({
    data: {
      kind: input.kind,
      channel: "EMAIL",
      studentId: input.studentId ?? null,
      applicationId: input.applicationId ?? null,
      recipient: input.to,
      subject: input.subject,
      // The attachment is not stored — it is rebuilt from live data on demand —
      // so the log notes what went out rather than pretending to hold a copy.
      body: input.attachments?.length
        ? `${input.body}\n\n[Attached: ${input.attachments.map((a) => a.filename).join(", ")}]`
        : input.body,
      provider: provider.name,
    },
  });

  const result = await provider.send({
    to: input.to,
    subject: input.subject,
    body: input.body,
    attachments: input.attachments,
  });

  await prisma.notificationLog.update({
    where: { id: log.id },
    data: result.ok
      ? { status: "SENT", sentAt: new Date(), providerMessageId: result.providerMessageId ?? null }
      : { status: "FAILED", error: result.error },
  });

  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

function signOff(instituteName: string): string {
  return `\n\n— ${instituteName}`;
}

export async function queueApplicationNotification(applicationId: string, kind: NotificationKind): Promise<void> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { guardians: { where: { isPrimary: true }, take: 1 } },
  });
  if (!application) return;

  const institute = await getInstitute().catch(() => null);
  const instituteName = institute?.name ?? "the institute";
  const primaryGuardian = application.guardians[0];

  const messages: Record<string, { subject: string; body: string }> = {
    APPLICATION_SUBMITTED: {
      subject: `Application ${application.applicationNo} received`,
      body:
        `Dear ${application.fullName},\n\n` +
        `We have received your admission application. Your application ID is ${application.applicationNo}. ` +
        `You will hear from us once the review is complete.` +
        signOff(instituteName),
    },
    APPLICATION_STATUS_CHANGE: {
      subject: `Update on application ${application.applicationNo}`,
      body:
        `Dear ${application.fullName},\n\n` +
        `The status of your application ${application.applicationNo} is now: ${application.status.replaceAll("_", " ").toLowerCase()}.` +
        (application.decisionReason ? `\n\nRemarks: ${application.decisionReason}` : "") +
        signOff(instituteName),
    },
    APPLICATION_INCOMPLETE: {
      subject: `Your application is incomplete`,
      body:
        `Dear ${application.fullName},\n\n` +
        `Your admission application is still incomplete. Please contact the admissions office to finish it.` +
        signOff(instituteName),
    },
    DOCUMENTS_PENDING: {
      subject: `Documents pending for application ${application.applicationNo}`,
      body:
        `Dear ${application.fullName},\n\n` +
        `Some required documents are still pending on your application ${application.applicationNo}.` +
        signOff(instituteName),
    },
  };

  const message = messages[kind];
  if (!message) return;

  // Order matters and is fixed by the template's own {{1}}, {{2}} — see
  // WHATSAPP_TEMPLATES, which is written against these same sequences.
  const applicationNo = application.applicationNo ?? "—";
  const templateVariables: Record<string, string[]> = {
    APPLICATION_SUBMITTED: [application.fullName, applicationNo],
    APPLICATION_STATUS_CHANGE: [
      application.fullName,
      applicationNo,
      application.status.replaceAll("_", " ").toLowerCase(),
    ],
    APPLICATION_INCOMPLETE: [application.fullName],
    DOCUMENTS_PENDING: [application.fullName, applicationNo],
  };

  await deliver({
    kind,
    applicationId,
    recipient: {
      email: application.email ?? primaryGuardian?.email ?? null,
      phone: application.phone ?? primaryGuardian?.phone ?? null,
    },
    subject: message.subject,
    body: message.body,
    templateVariables: templateVariables[kind],
  });
}

/** Welcome message on enrollment confirmation (spec 1.4 step 9 / 1.6). */
export async function queueWelcomeNotification(studentId: string): Promise<void> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: { batch: true, course: true },
  });
  if (!student) return;

  const institute = await getInstitute().catch(() => null);
  const instituteName = institute?.name ?? "the institute";

  await deliver({
    kind: "WELCOME",
    studentId,
    recipient: { email: student.email, phone: student.phone },
    templateVariables: [student.fullName, student.studentCode, student.course.name, student.batch.name],
    subject: `Welcome to ${instituteName}`,
    body:
      `Dear ${student.fullName},\n\n` +
      `Your admission is confirmed. Your Student ID is ${student.studentCode}.\n` +
      `Course: ${student.course.name}\nBatch: ${student.batch.name}\n\n` +
      `The admissions office will share your login credentials and joining instructions separately.` +
      signOff(instituteName),
  });
}

/* -------------------------------------------------------------------------- */
/* Fee reminders (spec 3.3)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything a reminder needs about who it is for.
 *
 * Handed in by the caller rather than looked up here. The pass has already
 * loaded every one of these rows to work out who owes what, and re-reading them
 * one installment at a time was a round trip per reminder on a job that has a
 * fixed number of seconds to reach every student.
 */
export type FeeReminderTarget = {
  installmentId: string;
  seqNo: number;
  dueDate: Date;
  student: {
    id: string;
    fullName: string;
    studentCode: string;
    email: string | null;
    phone: string | null;
    /** Primary guardian, used when the student has no contact of their own. */
    guardian: { email: string | null; phone: string | null } | null;
  };
};

export async function sendFeeReminder({
  target,
  kind,
  outstandingPaise,
  lateFeePaise,
  instituteName,
  channels,
}: {
  target: FeeReminderTarget;
  kind: "FEE_PRE_DUE" | "FEE_OVERDUE";
  outstandingPaise: number;
  lateFeePaise: number;
  /** Resolved once by the caller; falls back to a lookup for one-off sends. */
  instituteName?: string;
  channels?: Channels;
}): Promise<{ sent: number; failed: number }> {
  const { student, dueDate, seqNo, installmentId } = target;
  const guardian = student.guardian;
  const name = instituteName ?? (await getInstitute().catch(() => null))?.name ?? "the institute";

  const isPreDue = kind === "FEE_PRE_DUE";
  const subject = isPreDue
    ? `Fee due on ${formatDate(dueDate)} — ${student.studentCode}`
    : `Overdue fee — ${student.studentCode}`;

  const body =
    `Dear ${student.fullName},\n\n` +
    (isPreDue
      ? `This is a reminder that installment ${seqNo} is due on ${formatDate(dueDate)}.\n`
      : `Installment ${seqNo} was due on ${formatDate(dueDate)} and is still unpaid.\n`) +
    `Outstanding balance: ${formatPaise(outstandingPaise)}\n` +
    (lateFeePaise > 0 ? `Late fee accrued: ${formatPaise(lateFeePaise)}\n` : "") +
    `Total payable: ${formatPaise(outstandingPaise + lateFeePaise)}\n\n` +
    `Please pay at the accounts office to avoid further late fees.` +
    signOff(name);

  return deliver({
    kind,
    installmentId,
    studentId: student.id,
    templateVariables: [
      student.fullName,
      String(seqNo),
      formatDate(dueDate),
      formatPaise(outstandingPaise + lateFeePaise),
    ],
    // An empty string is a contact nobody can be reached on, so it falls through
    // to the guardian exactly as a missing one does. `??` alone would keep it
    // and quietly address the reminder to nowhere.
    recipient: {
      email: student.email || guardian?.email || null,
      phone: student.phone || guardian?.phone || null,
    },
    subject,
    body,
    channels,
  });
}
