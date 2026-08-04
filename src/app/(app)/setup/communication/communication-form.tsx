"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Alert, Card, Checkbox, Field, FormActions, FormGrid, Input, Select } from "@/components/ui";
import { saveCommunicationAction, sendTestEmailAction } from "../actions";

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
  hasSmtpPassword: boolean;
  hasWhatsappApiKey: boolean;
};

export function CommunicationForm({ config }: { config: CommsView }) {
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
                <Field label="Sender ID / from number" htmlFor="whatsappSenderId" error={fieldError(state, "whatsappSenderId")}>
                  <Input id="whatsappSenderId" name="whatsappSenderId" defaultValue={config.whatsappSenderId ?? ""} />
                </Field>
              </FormGrid>
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
