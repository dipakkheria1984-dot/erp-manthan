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

/**
 * What the gateway actually answered, kept alongside the verdict.
 *
 * A provider that accepts a request and queues nothing is indistinguishable
 * from one that worked, unless the raw answer is retained. The test screen
 * prints this so "it said sent but nothing arrived" becomes a readable HTTP
 * status and body rather than a mystery.
 */
export type SendDiagnostic = { status: number; body: string };

export type SendResult =
  | { ok: true; providerMessageId?: string; diagnostic?: SendDiagnostic }
  | { ok: false; error: string; diagnostic?: SendDiagnostic };

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
/**
 * The exact request this provider would make.
 *
 * Shared with the test screen so a dry run shows what a real send would put on
 * the wire — the two cannot drift, because there is only one of them. The token
 * is deliberately not part of it: the payload is shown to an admin on screen,
 * and a secret has no business being rendered.
 */
export function templatePanelRequest(
  config: Pick<CommunicationConfig, "whatsappApiUrl" | "whatsappSenderId" | "whatsappExtra">,
  kind: NotificationKind,
  to: string,
  variables: string[],
): { url: string; body: Record<string, string> } | { error: string } {
  if (!config.whatsappApiUrl) return { error: "WhatsApp API URL is not configured." };
  if (!config.whatsappSenderId) return { error: "The sender's phone number ID is not configured." };

  const { names, language } = templateSettings(config.whatsappExtra);
  const templateName = names[kind];
  if (!templateName) {
    return {
      error:
        `No approved WhatsApp template is mapped to ${kind}. Create and get the template approved in the ` +
        `provider's panel, then name it under Setup → Communication.`,
    };
  }

  // The panel numbers its placeholders from one: field_1, field_2, ...
  const fields: Record<string, string> = {};
  variables.forEach((value, index) => {
    fields[`field_${index + 1}`] = value;
  });

  return {
    url: config.whatsappApiUrl,
    body: {
      from_phone_number_id: config.whatsappSenderId,
      phone_number: toPanelNumber(to),
      template_name: templateName,
      template_language: language,
      ...fields,
    },
  };
}

class TemplatePanelWhatsAppProvider implements NotificationProvider {
  constructor(
    readonly name: string,
    private readonly config: CommunicationConfig,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!message.to) return { ok: false, error: "No WhatsApp number on file." };
    if (!this.config.whatsappApiKey) return { ok: false, error: "WhatsApp API token is not configured." };
    if (!message.kind) return { ok: false, error: "This message has no kind, so no template can be chosen." };

    const request = templatePanelRequest(this.config, message.kind, message.to, message.templateVariables ?? []);
    if ("error" in request) return { ok: false, error: request.error };

    // Appended rather than concatenated so an address that already carries a
    // query string does not end up with two "?".
    const url = new URL(request.url);
    url.searchParams.set("token", this.config.whatsappApiKey);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
        body: JSON.stringify(request.body),
      });

      // Read once, as text. A panel that answers with an HTML error page or an
      // empty body would otherwise throw inside `json()` and lose the only
      // evidence of what went wrong.
      const raw = await response.text().catch(() => "");
      const diagnostic: SendDiagnostic = { status: response.status, body: raw.slice(0, 1000) };

      if (!response.ok) {
        return { ok: false, error: `${this.name} returned ${response.status}. ${raw.slice(0, 200)}`.trim(), diagnostic };
      }

      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // 200 with a body that is not JSON is not an acknowledgement of
        // anything. Panels answer this way when a route is wrong and a login
        // page comes back with a cheerful status code.
        return {
          ok: false,
          error: `${this.name} answered ${response.status} but not with JSON, so nothing was queued.`,
          diagnostic,
        };
      }

      // These panels nest the useful part: `{"result":"success","data":{"wamid":…}}`
      // as often as they put an id at the top level.
      const nested = (data.data ?? {}) as Record<string, unknown>;
      const id = (data.message_id ?? data.messageId ?? data.id ?? nested.wamid ?? nested.message_id) as
        | string
        | undefined;

      // Treated as failure unless the answer positively says otherwise. The
      // opposite default — success unless it says "error" — reported messages
      // as sent that the panel never accepted, which is worse than a false
      // alarm because nobody goes looking.
      //
      // `result` belongs in this list for the same reason: without it a panel
      // answering `{"result":"success"}` would have every delivered message
      // logged as a failure, which is the same lie told the other way round.
      const succeeded =
        data.result === "success" ||
        data.status === "success" ||
        data.success === true ||
        Boolean(id);

      // An explicit failure wins over an id that happens to be present, so a
      // rejection carrying a null wamid is never read as an acknowledgement.
      const refused = data.result === "failed" || data.status === "error" || data.success === false;

      if (refused || !succeeded) {
        const said = String(data.message ?? data.error ?? data.result ?? data.status ?? "no acknowledgement");
        return { ok: false, error: `${this.name} did not acknowledge the message: ${said}`.slice(0, 300), diagnostic };
      }

      return { ok: true, providerMessageId: id, diagnostic };
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
