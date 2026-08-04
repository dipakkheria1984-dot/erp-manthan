import { getCommunicationConfig } from "@/lib/config";
import { emailIsLive } from "@/lib/notification-providers";
import { PageHeader } from "@/components/ui";
import { CommunicationForm, EmailTestCard } from "./communication-form";

export const metadata = { title: "Communication · Setup" };

export default async function CommunicationPage() {
  const config = await getCommunicationConfig();
  return (
    <>
      <PageHeader
        title="Communication setup"
        description="Email and WhatsApp providers are pluggable adapters. Until real credentials are configured they run in log-only mode, so nothing else in the system is blocked."
      />
      <div className="space-y-6">
        <CommunicationForm
          config={{
          emailProvider: config.emailProvider,
          smtpHost: config.smtpHost,
          smtpPort: config.smtpPort,
          smtpSecure: config.smtpSecure,
          smtpUser: config.smtpUser,
          smtpFromName: config.smtpFromName,
          smtpFromEmail: config.smtpFromEmail,
          whatsappProvider: config.whatsappProvider,
          whatsappApiUrl: config.whatsappApiUrl,
          whatsappSenderId: config.whatsappSenderId,
            hasSmtpPassword: Boolean(config.smtpPassword),
            hasWhatsappApiKey: Boolean(config.whatsappApiKey),
          }}
        />
        <EmailTestCard isLive={emailIsLive(config)} />
      </div>
    </>
  );
}
