import { getInstitute } from "@/lib/config";
import { PageHeader } from "@/components/ui";
import { PrintThemeForm } from "./print-theme-form";

export const metadata = { title: "Printed material · Setup" };

export default async function PrintingPage() {
  const institute = await getInstitute().catch(() => null);

  return (
    <>
      <PageHeader
        title="Printed material"
        description="Colour scheme and theme for every document the system generates — fee receipts, admission forms, the welcome kit and report exports."
      />
      <PrintThemeForm institute={institute} />
    </>
  );
}
