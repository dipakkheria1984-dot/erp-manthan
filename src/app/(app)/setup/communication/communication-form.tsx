"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Alert, Card, Checkbox, Field, FormActions, FormGrid, Input, Select } from "@/components/ui";
import { saveCommunicationAction, sendTestEmailAction, sendTestWhatsAppAction } from "../actions";

/** Secrets are never sent back to the browser — only whether one is stored. */
type CommsView = {
  emailProvider: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpFromName: string | null;
  smtpFromEmail: string | null;
  whatsappProvider: string | null;
  whatsappApiUrl: string | null;
  whatsappSenderId: string | null;
  whatsappTemplateLanguage: string;
  whatsappTemplateNames: Record<string, string | undefined>;
  hasSmtpPassword: boolean;
  hasWhatsappApiKey: boolean;
};

/** The template specs, passed in because their module is server-only. */
type TemplateView = { kind: string; label: string; variables: string[]; example: string };

export function CommunicationForm({
  config,
  templates,
}: {
  config: CommsView;
  templates: TemplateView[];
}) {
  const [provider, setProvider] = useState(config.emailProvider);
  const isGmail = provider === "gmail";

  return (
    <ActionForm action={saveCommunicationAction} className="space-y-6">
      {(state) => (
        <>
          <Card
            title="Email gateway"
            description="Used for reminders and for emailing receipts, welcome kits, ledgers and reports."
          >
            <FormGrid cols={2}>
              <Field label="Provider" htmlFor="emailProvider" required error={fieldError(state, "emailProvider")}>
                <Select
                  id="emailProvider"
                  name="emailProvider"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                >
                  <option value="mock">Mock (log only — nothing is delivered)</option>
                  <option value="gmail">Gmail (App Password)</option>
                  <option value="smtp">Other SMTP server</option>
                </Select>
              </Field>
            </FormGrid>

            {isGmail ? (
              <div className="mt-4 space-y-4">
                <Alert tone="info" title="Gmail needs an App Password, not your account password">
                  <ol className="ml-4 list-decimal space-y-1">
                    <li>Turn on 2-Step Verification for the Google account.</li>
                    <li>
                      Go to{" "}
                      <a
                        href="https://myaccount.google.com/apppasswords"
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium underline"
                      >
                        myaccount.google.com/apppasswords
                      </a>{" "}
                      and create one for this app.
                    </li>
                    <li>Paste the 16-character password below. Spaces are fine — they are stripped on save.</li>
                  </ol>
                  <p className="mt-2">
                    The server and port are set for you (smtp.gmail.com:587). Gmail sends as the account below whatever
                    “From email” says, so leave that blank unless you have configured a Gmail alias.
                  </p>
                </Alert>
                <FormGrid cols={2}>
                  <Field label="Gmail address" htmlFor="smtpUser" required error={fieldError(state, "smtpUser")}>
                    <Input
                      id="smtpUser"
                      name="smtpUser"
                      type="email"
                      defaultValue={config.smtpUser ?? ""}
                      autoComplete="off"
                      placeholder="office@yourinstitute.com"
                    />
                  </Field>
                  <Field
                    label="App password"
                    htmlFor="smtpPassword"
                    required={!config.hasSmtpPassword}
                    hint={
                      config.hasSmtpPassword
                        ? "An App Password is stored. Leave blank to keep it."
                        : "16 characters, from Google — not your Gmail password."
                    }
                    error={fieldError(state, "smtpPassword")}
                  >
                    <Input
                      id="smtpPassword"
                      name="smtpPassword"
                      type="password"
                      autoComplete="new-password"
                      placeholder={config.hasSmtpPassword ? "••••••••••••••••" : "abcd efgh ijkl mnop"}
                    />
                  </Field>
                  <Field label="From name" htmlFor="smtpFromName" error={fieldError(state, "smtpFromName")}>
                    <Input id="smtpFromName" name="smtpFromName" defaultValue={config.smtpFromName ?? ""} />
                  </Field>
                  <Field
                    label="From email"
                    htmlFor="smtpFromEmail"
                    hint="Optional — only if this address is a verified Gmail alias."
                    error={fieldError(state, "smtpFromEmail")}
                  >
                    <Input id="smtpFromEmail" name="smtpFromEmail" type="email" defaultValue={config.smtpFromEmail ?? ""} />
                  </Field>
                </FormGrid>
                {/* Gmail's host, port and TLS mode are fixed; posted so the
                    stored row still describes the connection being used. */}
                <input type="hidden" name="smtpHost" value="smtp.gmail.com" />
                <input type="hidden" name="smtpPort" value="587" />
              </div>
            ) : (
              <div className="mt-4">
                <FormGrid cols={2}>
                  <Field label="SMTP host" htmlFor="smtpHost" error={fieldError(state, "smtpHost")}>
                    <Input id="smtpHost" name="smtpHost" defaultValue={config.smtpHost ?? ""} placeholder="smtp.example.com" />
                  </Field>
                  <Field label="SMTP port" htmlFor="smtpPort" error={fieldError(state, "smtpPort")}>
                    <Input id="smtpPort" name="smtpPort" type="number" defaultValue={config.smtpPort ?? ""} placeholder="587" />
                  </Field>
                  <Field label="Username" htmlFor="smtpUser" error={fieldError(state, "smtpUser")}>
                    <Input id="smtpUser" name="smtpUser" defaultValue={config.smtpUser ?? ""} autoComplete="off" />
                  </Field>
                  <Field
                    label="Password"
                    htmlFor="smtpPassword"
                    hint={config.hasSmtpPassword ? "A password is stored. Leave blank to keep it." : undefined}
                    error={fieldError(state, "smtpPassword")}
                  >
                    <Input id="smtpPassword" name="smtpPassword" type="password" autoComplete="new-password" placeholder={config.hasSmtpPassword ? "••••••••" : ""} />
                  </Field>
                  <Field label="From name" htmlFor="smtpFromName" error={fieldError(state, "smtpFromName")}>
                    <Input id="smtpFromName" name="smtpFromName" defaultValue={config.smtpFromName ?? ""} />
                  </Field>
                  <Field label="From email" htmlFor="smtpFromEmail" error={fieldError(state, "smtpFromEmail")}>
                    <Input id="smtpFromEmail" name="smtpFromEmail" type="email" defaultValue={config.smtpFromEmail ?? ""} />
                  </Field>
                  <div className="flex items-center gap-2 pt-7">
                    <Checkbox id="smtpSecure" name="smtpSecure" defaultChecked={config.smtpSecure} />
                    <label htmlFor="smtpSecure" className="text-sm">
                      Use TLS on connect (port 465)
                    </label>
                  </div>
                </FormGrid>
              </div>
            )}
          </Card>

          <Card title="WhatsApp">
            <Alert tone="info">
              The provider is swappable without touching reminder logic. Pick your gateway and supply its API endpoint
              and key; the adapter layer normalises the rest.
            </Alert>
            <div className="mt-4">
              <FormGrid cols={2}>
                <Field label="Provider" htmlFor="whatsappProvider" required error={fieldError(state, "whatsappProvider")}>
                  <Select id="whatsappProvider" name="whatsappProvider" defaultValue={config.whatsappProvider ?? "mock"}>
                    <option value="mock">Mock (log only)</option>
                    <option value="twilio">Twilio</option>
                    <option value="gupshup">Gupshup</option>
                    <option value="meta">Meta WhatsApp Business API</option>
                    <option value="template_panel">Reseller panel (approved templates)</option>
                  </Select>
                </Field>
                <Field label="API URL" htmlFor="whatsappApiUrl" error={fieldError(state, "whatsappApiUrl")}>
                  <Input id="whatsappApiUrl" name="whatsappApiUrl" defaultValue={config.whatsappApiUrl ?? ""} />
                </Field>
                <Field
                  label="API key / token"
                  htmlFor="whatsappApiKey"
                  hint={config.hasWhatsappApiKey ? "A key is stored. Leave blank to keep it." : undefined}
                  error={fieldError(state, "whatsappApiKey")}
                >
                  <Input id="whatsappApiKey" name="whatsappApiKey" type="password" autoComplete="new-password" placeholder={config.hasWhatsappApiKey ? "••••••••" : ""} />
                </Field>
                <Field
                  label="Sender ID / from number"
                  htmlFor="whatsappSenderId"
                  hint="On a reseller panel this is the from_phone_number_id it issued, not the phone number itself."
                  error={fieldError(state, "whatsappSenderId")}
                >
                  <Input id="whatsappSenderId" name="whatsappSenderId" defaultValue={config.whatsappSenderId ?? ""} />
                </Field>
              </FormGrid>
            </div>

            <div className="mt-6 border-t border-border pt-4">
              <p className="text-sm font-medium">Approved message templates</p>
              <div className="mt-3">
                <Alert tone="warning" title="WhatsApp cannot send free text">
                  Meta only allows a business to open a conversation with a template it has approved in advance,
                  so the wording below is fixed when the template is approved — not by this system. Create each
                  one in your provider&rsquo;s panel with the placeholders in the order listed, wait for approval,
                  then put its name here. A message with no template mapped is not sent, and says so in the log.
                </Alert>
              </div>

              <div className="mt-4 max-w-xs">
                <Field
                  label="Template language"
                  htmlFor="whatsappTemplateLanguage"
                  hint="The language code the templates were approved under, e.g. en or en_US."
                  error={fieldError(state, "whatsappTemplateLanguage")}
                >
                  <Input
                    id="whatsappTemplateLanguage"
                    name="whatsappTemplateLanguage"
                    defaultValue={config.whatsappTemplateLanguage}
                  />
                </Field>
              </div>

              <div className="mt-4 space-y-4">
                {templates.map((template) => (
                  <Field
                    key={template.kind}
                    label={`${template.label} — template name`}
                    htmlFor={`tpl-${template.kind}`}
                    hint={`Placeholders in order: ${template.variables
                      .map((variable, index) => `{{${index + 1}}} ${variable}`)
                      .join(", ")}. Example: ${template.example}`}
                    error={fieldError(state, `template_${template.kind}`)}
                  >
                    <Input
                      id={`tpl-${template.kind}`}
                      name={`template_${template.kind}`}
                      defaultValue={config.whatsappTemplateNames[template.kind] ?? ""}
                      placeholder="Not mapped — this message will not be sent on WhatsApp"
                    />
                  </Field>
                ))}
              </div>
            </div>
            <FormActions>
              <SubmitButton pendingLabel="Saving…">Save communication settings</SubmitButton>
            </FormActions>
          </Card>
        </>
      )}
    </ActionForm>
  );
}

/**
 * Test send, in its own form because HTML forbids nesting one inside another —
 * and because it must run against the *saved* settings, not the unsaved ones on
 * screen.
 */
export function EmailTestCard({ isLive }: { isLive: boolean }) {
  return (
    <Card
      title="Send a test email"
      description="Uses the saved settings. Save any changes above first."
    >
      {isLive ? null : (
        <div className="mb-4">
          <Alert tone="warning">
            The email provider is set to Mock, so nothing is delivered — sends are only written to the notification
            log. Choose Gmail or SMTP above and save to send for real.
          </Alert>
        </div>
      )}
      <ActionForm action={sendTestEmailAction}>
        {(state) => (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Send to" htmlFor="testTo" error={fieldError(state, "testTo")} className="min-w-64 flex-1">
              <Input id="testTo" name="testTo" type="email" placeholder="you@example.com" required />
            </Field>
            <SubmitButton variant="secondary" pendingLabel="Sending…" disabled={!isLive}>
              Send test
            </SubmitButton>
          </div>
        )}
      </ActionForm>
    </Card>
  );
}

/**
 * Proves the WhatsApp gateway before the nightly job depends on it.
 *
 * Deliberately usable while the provider is still Mock. Nothing leaves the
 * building then, and the request that *would* have gone is printed instead — a
 * template mapping and a sender id can be checked before a single family is
 * messaged. Once the provider is live the same button sends for real.
 */
export function WhatsAppTestCard({
  isLive,
  templates,
  mapped,
}: {
  isLive: boolean;
  templates: TemplateView[];
  /** Kinds that actually have a template name saved. */
  mapped: string[];
}) {
  const sendable = templates.filter((template) => mapped.includes(template.kind));

  return (
    <Card
      title="Send a test WhatsApp"
      description="Uses the saved settings. Save any changes above first."
    >
      <div className="mb-4">
        <Alert tone={isLive ? "info" : "warning"}>
          {isLive
            ? "The provider is live, so this sends a real WhatsApp message. Use your own number."
            : "The provider is set to Mock, so nothing is delivered — the request that a live send would make is shown instead. That is enough to check a template name, the sender ID and the values that fill the blanks."}
        </Alert>
      </div>

      {sendable.length === 0 ? (
        <Alert tone="warning" title="No templates mapped yet">
          Name at least one approved template above and save. Until then there is nothing WhatsApp could be asked
          to send.
        </Alert>
      ) : (
        <ActionForm action={sendTestWhatsAppAction}>
          {(state) => {
            const result =
              state?.ok && state.data && typeof state.data === "object"
                ? (state.data as {
                    live: boolean;
                    delivered: boolean;
                    outcome: string;
                    url: string;
                    body: Record<string, string>;
                    responseStatus?: number;
                    responseBody?: string;
                    tokenLength?: number;
                  })
                : null;
            return (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <Field
                    label="Send to"
                    htmlFor="testWhatsAppTo"
                    hint="With or without +91."
                    error={fieldError(state, "testWhatsAppTo")}
                    className="min-w-56 flex-1"
                  >
                    <Input id="testWhatsAppTo" name="testWhatsAppTo" placeholder="98200 11111" required />
                  </Field>
                  <Field
                    label="Message"
                    htmlFor="testWhatsAppKind"
                    error={fieldError(state, "testWhatsAppKind")}
                    className="min-w-56 flex-1"
                  >
                    <Select id="testWhatsAppKind" name="testWhatsAppKind" defaultValue={sendable[0]?.kind}>
                      {sendable.map((template) => (
                        <option key={template.kind} value={template.kind}>
                          {template.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <SubmitButton variant="secondary" pendingLabel="Sending…">
                    {isLive ? "Send test" : "Show the request"}
                  </SubmitButton>
                </div>

                <div className="mt-3">
                  <Field
                    label="Values to send (optional)"
                    htmlFor="testWhatsAppValues"
                    hint="Comma-separated, one per placeholder. Leave blank for the sample values. Useful for narrowing down what a gateway objects to — try it without the ₹ symbol, for instance."
                    error={fieldError(state, "testWhatsAppValues")}
                  >
                    <Input
                      id="testWhatsAppValues"
                      name="testWhatsAppValues"
                      placeholder="Test Student, 2, 07 Aug 2026, 25000"
                    />
                  </Field>
                </div>

                {result ? (
                  <div className="mt-4 space-y-3">
                    <Alert tone={result.live ? (result.delivered ? "success" : "danger") : "info"}>
                      {result.outcome}
                    </Alert>
                    <div>
                      <p className="text-xs font-medium text-muted">
                        The request {result.live ? "sent" : "a live send would make"}
                      </p>
                      <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">
                        {`POST ${result.url}?token=${"•".repeat(8)}

${JSON.stringify(result.body, null, 2)}`}
                      </pre>
                      <p className="mt-1 text-xs text-muted">
                        {result.tokenLength
                          ? `The token is attached to the URL — ${result.tokenLength} characters, masked here only for display.`
                          : "No token is stored, so nothing was attached. Enter it above and save."}
                      </p>
                    </div>

                    {result.responseStatus !== undefined ? (
                      <div>
                        <p className="text-xs font-medium text-muted">
                          What the provider answered — HTTP {result.responseStatus}
                        </p>
                        <pre className="mt-1 max-h-52 overflow-auto rounded-md border border-border bg-background p-3 text-xs">
                          {result.responseBody?.trim() || "(empty response body)"}
                        </pre>
                        <p className="mt-1 text-xs text-muted">
                          If this says the message was accepted but nothing arrives, the message was queued and
                          dropped later — check the panel&rsquo;s own delivery log and that the template is
                          approved under this exact name and language.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            );
          }}
        </ActionForm>
      )}
    </Card>
  );
}
