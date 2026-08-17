import { getConfig } from "@/lib/config";
import { Card, PageHeader } from "@/components/ui";
import { ConfigForm } from "./config-form";
import { PaymentQrForm } from "./payment-qr-form";

export const metadata = { title: "Global configuration · Setup" };

export default async function ConfigPage() {
  const config = await getConfig();
  return (
    <>
      <PageHeader
        title="Global configuration"
        description="Institute-wide business rules. Some of these values are deliberately hidden from Registrar and Accountant screens."
      />
      <div className="space-y-6">
        <ConfigForm config={config} />

        {/* Outside the configuration form on purpose: a file cannot be carried
            through that form's save, and nested forms are not valid HTML. */}
        <Card
          title="Payment QR"
          description="The code applicants scan on the registration fee step. Upload the one your bank issued."
        >
          <PaymentQrForm
            hasQr={Boolean(config.paymentQrStoragePath)}
            fileName={config.paymentQrFileName}
            version={config.paymentQrUpdatedAt?.getTime() ?? 0}
          />
        </Card>
      </div>
    </>
  );
}
