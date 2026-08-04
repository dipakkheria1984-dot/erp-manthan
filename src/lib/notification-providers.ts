import "server-only";
import nodemailer from "nodemailer";
import type { CommunicationConfig } from "@/generated/prisma/client";

/**
 * Pluggable notification transport (spec 11.2).
 *
 * Reminder logic never talks to a vendor SDK directly — it asks for a provider
 * by channel and calls `send`. Swapping WhatsApp gateways is a change to this
 * file plus a dropdown value in Institute Setup, nothing more.
 */

export type SendResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string };

/** A file sent with an email — a receipt, a welcome kit, a report export. */
export type Attachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

export type OutboundMessage = {
  to: string;
  subject?: string;
  body: string;
  /** Email only. Text-based WhatsApp adapters ignore these. */
  attachments?: Attachment[];
};

export interface NotificationProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/* -------------------------------------------------------------------------- */
/* Mock — used until real credentials are configured                           */
/* -------------------------------------------------------------------------- */

class MockProvider implements NotificationProvider {
  constructor(readonly name: string) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const files = message.attachments?.length
      ? ` [${message.attachments.map((a) => `${a.filename} ${Math.round(a.content.length / 1024)}KB`).join(", ")}]`
      : "";
    console.info(`[${this.name}] → ${message.to}${message.subject ? ` — ${message.subject}` : ""}${files}`);
    if (!message.to) return { ok: false, error: "No recipient address on file." };
    return { ok: true, providerMessageId: `mock-${Date.now()}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Email                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Gmail's submission endpoint. Fixed rather than typed in, because getting any
 * of it wrong produces an SMTP error that reads nothing like "you used your
 * account password instead of an App Password".
 */
export const GMAIL_SMTP = { host: "smtp.gmail.com", port: 587, secure: false } as const;

/** Connection settings for a config, with Gmail's filled in for the admin. */
export function smtpSettingsFor(config: CommunicationConfig) {
  return config.emailProvider === "gmail"
    ? { ...GMAIL_SMTP, user: config.smtpUser, pass: config.smtpPassword }
    : {
        host: config.smtpHost,
        port: config.smtpPort ?? 587,
        secure: config.smtpSecure,
        user: config.smtpUser,
        pass: config.smtpPassword,
      };
}

class SmtpProvider implements NotificationProvider {
  constructor(
    readonly name: string,
    private readonly config: CommunicationConfig,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!message.to) return { ok: false, error: "No email address on file." };

    const settings = smtpSettingsFor(this.config);
    if (!settings.host) return { ok: false, error: "SMTP host is not configured." };
    if (this.name === "gmail" && !settings.pass) {
      return { ok: false, error: "Gmail needs a 16-character App Password. Set one in Communication setup." };
    }

    try {
      const transport = nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        auth: settings.user ? { user: settings.user, pass: settings.pass ?? "" } : undefined,
      });

      // Gmail rewrites the From header to the authenticated account anyway, so
      // fall back to it rather than sending a header Gmail will silently replace.
      const fromAddress = this.config.smtpFromEmail ?? (this.name === "gmail" ? settings.user : null);

      const info = await transport.sendMail({
        from: fromAddress ? { name: this.config.smtpFromName ?? "", address: fromAddress } : undefined,
        to: message.to,
        subject: message.subject ?? "Notification",
        text: message.body,
        attachments: message.attachments?.map((file) => ({
          filename: file.filename,
          content: file.content,
          contentType: file.contentType,
        })),
      });
      return { ok: true, providerMessageId: info.messageId };
    } catch (error) {
      return { ok: false, error: describeSmtpError(error, this.name) };
    }
  }
}

/**
 * Gmail answers a wrong password with a bare "535-5.7.8 Username and Password
 * not accepted", which sends admins hunting through their account settings.
 * Nine times out of ten it means an account password was used where an App
 * Password was required, so say that.
 */
function describeSmtpError(error: unknown, provider: string): string {
  const message = error instanceof Error ? error.message : "SMTP delivery failed.";
  if (provider === "gmail" && /535|Username and Password not accepted|BadCredentials/i.test(message)) {
    return (
      "Gmail rejected the credentials. Use a 16-character App Password, not the account password — " +
      "2-Step Verification must be on for the account first. " +
      message
    );
  }
  return message;
}

/* -------------------------------------------------------------------------- */
/* WhatsApp                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Generic HTTP WhatsApp adapter. Each supported gateway differs only in its
 * request shape, so the payload builder is selected by provider name and
 * everything else — auth header, error handling, message id — is shared.
 */
class HttpWhatsAppProvider implements NotificationProvider {
  constructor(
    readonly name: string,
    private readonly config: CommunicationConfig,
  ) {}

  private buildPayload(to: string, body: string): Record<string, unknown> {
    switch (this.name) {
      case "twilio":
        return { To: `whatsapp:${to}`, From: `whatsapp:${this.config.whatsappSenderId ?? ""}`, Body: body };
      case "gupshup":
        return { channel: "whatsapp", source: this.config.whatsappSenderId, destination: to, message: body };
      case "meta":
      default:
        return {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        };
    }
  }

  async send(message: { to: string; body: string }): Promise<SendResult> {
    if (!message.to) return { ok: false, error: "No WhatsApp number on file." };
    if (!this.config.whatsappApiUrl) return { ok: false, error: "WhatsApp API URL is not configured." };

    try {
      const response = await fetch(this.config.whatsappApiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.whatsappApiKey ? { authorization: `Bearer ${this.config.whatsappApiKey}` } : {}),
        },
        body: JSON.stringify(this.buildPayload(message.to, message.body)),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { ok: false, error: `${this.name} returned ${response.status}. ${text.slice(0, 200)}`.trim() };
      }

      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const id =
        (data.sid as string | undefined) ??
        (data.messageId as string | undefined) ??
        (Array.isArray(data.messages) ? ((data.messages[0] as { id?: string })?.id ?? undefined) : undefined);
      return { ok: true, providerMessageId: id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "WhatsApp delivery failed." };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

export function emailProviderFor(config: CommunicationConfig): NotificationProvider {
  if (config.emailProvider === "gmail") return new SmtpProvider("gmail", config);
  if (config.emailProvider === "smtp" && config.smtpHost) return new SmtpProvider("smtp", config);
  return new MockProvider("email:mock");
}

/** True when email actually leaves the building, rather than going to the log. */
export function emailIsLive(config: CommunicationConfig): boolean {
  return config.emailProvider === "gmail" || (config.emailProvider === "smtp" && Boolean(config.smtpHost));
}

export function whatsappProviderFor(config: CommunicationConfig): NotificationProvider {
  const provider = config.whatsappProvider ?? "mock";
  if (provider === "mock" || !config.whatsappApiUrl) return new MockProvider("whatsapp:mock");
  return new HttpWhatsAppProvider(provider, config);
}
