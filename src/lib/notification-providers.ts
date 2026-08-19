import "server-only";
import nodemailer from "nodemailer";
import type { CommunicationConfig, NotificationKind } from "@/generated/prisma/client";
import { templateSettings } from "@/lib/whatsapp-templates";

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
  /**
   * Which message this is, and the values that fill its approved WhatsApp
   * template — see src/lib/whatsapp-templates.ts. Email ignores both and sends
   * `body`; a template-only gateway ignores `body` and can send nothing without
   * them.
   */
  kind?: NotificationKind;
  templateVariables?: string[];
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

/**
 * The live transport, kept open between messages.
 *
 * A transport used to be built inside every `send`, which meant a TCP connect,
 * a TLS handshake and an SMTP AUTH round trip per message — one to three
 * seconds each against Gmail. The nightly reminder pass sends one per student
 * with dues, so on any real register it spent its whole 60s function budget on
 * handshakes and was killed part-way through, and every student after the
 * cut-off silently got nothing. Pooled, the pass opens a few connections and
 * reuses them for every message.
 *
 * Only one configuration is ever in play, so the cache holds a single entry.
 * The key covers everything that changes the connection: editing the SMTP
 * settings closes this transport and builds a new one, rather than carrying on
 * authenticated as the previous user.
 */
let pooled: { key: string; transport: nodemailer.Transporter } | null = null;

function transportFor(settings: ReturnType<typeof smtpSettingsFor>): nodemailer.Transporter {
  const key = JSON.stringify([settings.host, settings.port, settings.secure, settings.user, settings.pass]);
  if (pooled?.key === key) return pooled.transport;

  pooled?.transport.close();
  const transport = nodemailer.createTransport({
    host: settings.host ?? undefined,
    port: settings.port ?? undefined,
    secure: settings.secure,
    auth: settings.user ? { user: settings.user, pass: settings.pass ?? "" } : undefined,
    pool: true,
    maxConnections: 3,
    // One unresponsive connection must not swallow the pass's whole budget and
    // strand the students behind it — fail that message and move on.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  pooled = { key, transport };
  return transport;
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
      const transport = transportFor(settings);

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
 * Panels that resell the WhatsApp Business API as an approved-template service.
 *
 * Two things set these apart from the adapters below, and both break the
 * assumptions the generic one makes:
 *
 *  - **The token travels in the query string**, not an Authorization header.
 *    Sending it as a bearer header authenticates as nobody and the call is
 *    rejected.
 *  - **There is no message body.** The payload carries a template name and
 *    numbered fields; the composed text this system produces for email has
 *    nowhere to go. A message whose template has not been approved and mapped
 *    therefore cannot be sent at all, which is reported as such rather than
 *    posted and silently dropped.
 *
 * The URL holds the account path the panel issued; the token is stored
 * separately so a secret is never kept in a field the settings screen shows in
 * clear text.
 */
class TemplatePanelWhatsAppProvider implements NotificationProvider {
  constructor(
    readonly name: string,
    private readonly config: CommunicationConfig,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!message.to) return { ok: false, error: "No WhatsApp number on file." };
    if (!this.config.whatsappApiUrl) return { ok: false, error: "WhatsApp API URL is not configured." };
    if (!this.config.whatsappApiKey) return { ok: false, error: "WhatsApp API token is not configured." };
    if (!this.config.whatsappSenderId) {
      return { ok: false, error: "The sender's phone number ID is not configured." };
    }
    if (!message.kind) return { ok: false, error: "This message has no kind, so no template can be chosen." };

    const { names, language } = templateSettings(this.config.whatsappExtra);
    const templateName = names[message.kind];
    if (!templateName) {
      return {
        ok: false,
        error:
          `No approved WhatsApp template is mapped to ${message.kind}. Create and get the template approved in ` +
          `the provider's panel, then name it under Setup → Communication.`,
      };
    }

    // The panel numbers its placeholders from one: field_1, field_2, ...
    const fields: Record<string, string> = {};
    (message.templateVariables ?? []).forEach((value, index) => {
      fields[`field_${index + 1}`] = value;
    });

    // Appended rather than concatenated so an address that already carries a
    // query string does not end up with two "?".
    const url = new URL(this.config.whatsappApiUrl);
    url.searchParams.set("token", this.config.whatsappApiKey);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          from_phone_number_id: this.config.whatsappSenderId,
          phone_number: toPanelNumber(message.to),
          template_name: templateName,
          template_language: language,
          ...fields,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { ok: false, error: `${this.name} returned ${response.status}. ${text.slice(0, 200)}`.trim() };
      }

      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      // These panels disagree about the success envelope, so a body that
      // explicitly says it failed is treated as a failure even on HTTP 200.
      if (data.status === "error" || data.success === false) {
        return { ok: false, error: String(data.message ?? "The provider rejected the message.").slice(0, 200) };
      }
      const id = (data.message_id ?? data.messageId ?? data.id) as string | undefined;
      return { ok: true, providerMessageId: id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "WhatsApp delivery failed." };
    }
  }
}

/**
 * Numbers as these panels expect them: country code and subscriber digits, no
 * plus, no spaces. Stored numbers are typed by staff and arrive as "+91 98200
 * 11111" as often as "9820011111", so they are normalised here rather than
 * relying on every screen to have been consistent. A bare ten-digit Indian
 * number is given its country code; anything already carrying one is left be.
 */
export function toPanelNumber(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `91${digits}`;
  // 0-prefixed STD form, e.g. 09820011111.
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
}

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
  if (provider === "template_panel") return new TemplatePanelWhatsAppProvider(provider, config);
  return new HttpWhatsAppProvider(provider, config);
}

/** True when WhatsApp actually leaves the building, rather than going to the log. */
export function whatsappIsLive(config: CommunicationConfig): boolean {
  const provider = config.whatsappProvider ?? "mock";
  return provider !== "mock" && Boolean(config.whatsappApiUrl);
}
