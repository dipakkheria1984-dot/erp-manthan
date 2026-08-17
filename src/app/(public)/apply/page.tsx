import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { Alert, Card } from "@/components/ui";
import { StartForm } from "./start-form";

export const metadata: Metadata = { title: "Apply online" };

/**
 * The public landing page. Shows what the applicant is about to fill in, what
 * they will need to hand, and where it stops — the fee conversation is the
 * office's, and saying so here prevents the obvious support call.
 */
export default async function ApplyPage() {
  const config = await getConfig().catch(() => null);

  if (!config?.onlineAdmissionsEnabled) {
    return (
      <Alert tone="info" title="Online admissions are closed">
        We are not accepting online applications at the moment. Please contact the admissions office.
      </Alert>
    );
  }

  const requirements = await prisma.documentRequirement.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: { label: true, isRequired: true },
  });

  return (
    <div className="space-y-6">
      <Card title="Before you begin">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Your personal and contact details</li>
          <li>Your parent or guardian&rsquo;s details</li>
          <li>The department and course you want to apply for</li>
          <li>Scanned copies of your documents (PDF, JPG or PNG)</li>
        </ol>
        {requirements.length > 0 ? (
          <div className="mt-4">
            <p className="text-sm font-medium">Documents to have ready</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
              {requirements.map((requirement) => (
                <li key={requirement.label}>
                  {requirement.label}
                  {requirement.isRequired ? "" : " (optional)"}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-4 text-sm text-muted">
          You do not pay anything here. Once your form is in, the admissions office will check it and contact
          you about the course fees and how to pay them.
        </p>
      </Card>

      <StartForm />
    </div>
  );
}
