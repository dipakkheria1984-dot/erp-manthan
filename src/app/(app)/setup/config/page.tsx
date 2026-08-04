import { getConfig } from "@/lib/config";
import { PageHeader } from "@/components/ui";
import { ConfigForm } from "./config-form";

export const metadata = { title: "Global configuration · Setup" };

export default async function ConfigPage() {
  const config = await getConfig();
  return (
    <>
      <PageHeader
        title="Global configuration"
        description="Institute-wide business rules. Some of these values are deliberately hidden from Registrar and Accountant screens."
      />
      <ConfigForm config={config} />
    </>
  );
}
