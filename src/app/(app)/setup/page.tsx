import { getInstitute } from "@/lib/config";
import { PageHeader } from "@/components/ui";
import { InstituteLogoCard } from "./institute-logo-card";
import { InstituteProfileForm } from "./institute-profile-form";

export const metadata = { title: "Institute profile · Setup" };

export default async function InstituteProfilePage() {
  const institute = await getInstitute().catch(() => null);

  return (
    <>
      <PageHeader
        title="Institute profile"
        description="Appears on report headers, fee receipts and every outbound email or WhatsApp message."
      />
      <div className="space-y-6">
        <InstituteProfileForm institute={institute} />
        <InstituteLogoCard institute={institute} />
      </div>
    </>
  );
}
